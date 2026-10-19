// [Native Recorder] RECORDER-1 — unit tests of the UI contracts and the capture controller (Node type stripping).
// Fake tracks / streams / MediaRecorder / port: deterministic lifecycle, no device, no browser, no network.
// Usage: node --test scripts/test-recorder-ui-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickRecorderMime, RECORDER_MIME_PREFERENCE, containerLabel, recordingType, captureErrorCode, recorderErrorText, formatElapsed, formatBytes, isActive, STATE_LABEL,
} from '../src/lib/recorder/recorder-contracts.ts';
import { RecorderCaptureController } from '../src/lib/recorder/capture-controller.ts';

// ── fakes ──
class FakeTrack {
  constructor(kind) { this.kind = kind; this.readyState = 'live'; this.stops = 0; this.listeners = {}; }
  stop() { this.readyState = 'ended'; this.stops++; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  endByBrowser() { this.readyState = 'ended'; for (const fn of this.listeners.ended ?? []) fn(); }
  getSettings() { return this.kind === 'video' && this.readyState === 'live' ? { width: 1280, height: 720 } : {}; } // like Chromium: an ended track reports nothing
}
class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; } getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); } getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
globalThis.MediaStream = FakeStream;
function makeRecorderClass({ supported = ['video/webm;codecs=vp9,opus'], finalBlob = true, pausable = true } = {}) {
  return class FakeRecorder {
    static isTypeSupported(m) { return supported.includes(m); }
    static last = null;
    constructor(stream, opts) { this.stream = stream; this.mimeType = opts?.mimeType; this.state = 'inactive'; this.listeners = {}; FakeRecorder.last = this; if (!pausable) { this.pause = undefined; this.resume = undefined; } }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    start(ts) { this.state = 'recording'; this.timeslice = ts; }
    emit(n) { this.ondataavailable?.({ data: new Blob([new Uint8Array(n)]) }); }
    stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (finalBlob) this.emit(10); for (const fn of this.listeners.stop ?? []) fn(); }
    pause() { this.state = 'paused'; } resume() { this.state = 'recording'; }
  };
}
function makePort({ failAppendAt = null, delayAppend = 0, finalizeStatus = 'READY' } = {}) {
  const calls = []; const chunks = [];
  return {
    calls, chunks,
    async createSession(i) { calls.push(['createSession', i]); return { recordingId: 'rec_' + 'a'.repeat(32), sessionToken: 'tok', status: 'PREPARING', maxChunkBytes: 1e6, maxRecordingBytes: 1e9, maxDurationMs: 1e7 }; },
    async markStarted(id) { calls.push(['markStarted', id]); return {}; },
    async appendChunk(id, tok, seq, blob) { calls.push(['appendChunk', seq, blob.size]); if (delayAppend) await new Promise(r => setTimeout(r, delayAppend)); if (failAppendAt === seq) throw Object.assign(new Error('x'), { code: 'DISK_FULL' }); chunks.push(seq); return { seq, duplicate: false, received: 0 }; },
    async finalize(id, tok, meta) { calls.push(['finalize', meta]); return finalizeStatus === 'READY' ? { status: 'READY', recording: { recordingId: id, title: 't', sizeBytes: 1, durationMs: meta.durationMs, mimeType: 'video/webm' } } : { status: 'FAILED', error: 'EMPTY_RECORDING', recording: { recordingId: id } }; },
    async cancel(id) { calls.push(['cancel', id]); return {}; },
    async listRecordings() { return { items: [], total: 0 }; }, async getRecording() { return {}; },
  };
}
function makeEnv({ displayDenied = false, cameraDenied = false, micDenied = false, recorder = makeRecorderClass(), devices = null } = {}) {
  const acquired = []; let clock = 1000;
  const env = {
    acquired, MediaRecorder: recorder, now: () => clock, tick: (ms) => { clock += ms; },
    calls: { display: 0, user: 0 }, lastConstraints: [],
    mediaDevices: {
      async getDisplayMedia() { env.calls.display++; if (displayDenied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); const t = new FakeTrack('video'); acquired.push(t); return new FakeStream([t]); },
      async getUserMedia(c) {
        env.calls.user++; env.lastConstraints.push(c);
        if (c.video && cameraDenied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        if (c.audio && !c.video && micDenied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        const ts = [...(c.video ? [new FakeTrack('video')] : []), ...(c.audio ? [new FakeTrack('audio')] : [])]; acquired.push(...ts); return new FakeStream(ts);
      },
      // [MASTER WS2] enumerateDevices present only when `devices` is provided (an older env omits it entirely).
      ...(devices ? { async enumerateDevices() { return devices; } } : {}),
    },
  };
  return env;
}
const flush = () => new Promise(r => setTimeout(r, 0));
const allStopped = (env) => env.acquired.every(t => t.readyState === 'ended');

test('contracts: deterministic MIME preference (WebM first, MP4 fallback), labels, error codes', () => {
  assert.deepEqual([...RECORDER_MIME_PREFERENCE], ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']);
  assert.equal(pickRecorderMime(() => true), 'video/webm;codecs=vp9,opus');
  assert.equal(pickRecorderMime((m) => m.startsWith('video/mp4')), 'video/mp4;codecs=avc1,mp4a.40.2', 'Safari-like: MP4 only');
  assert.equal(pickRecorderMime((m) => m === 'video/webm'), 'video/webm');
  assert.equal(pickRecorderMime(() => false), null);
  assert.equal(pickRecorderMime(() => { throw new Error('x'); }), null);
  assert.equal(pickRecorderMime(null), null);
  assert.deepEqual([containerLabel('video/webm;codecs=vp9'), containerLabel('video/mp4'), containerLabel(null)], ['WebM', 'MP4', '—']);
  assert.deepEqual([recordingType('SCREEN', true), recordingType('CAMERA', false)], ['SCREEN_WITH_MIC', 'CAMERA']);
  assert.deepEqual([captureErrorCode({ name: 'NotAllowedError' }), captureErrorCode({ name: 'NotFoundError' }), captureErrorCode(new Error('x'))], ['PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'CAPTURE_FAILED']);
  assert.equal(recorderErrorText('SOMETHING'), 'Erreur d’enregistrement inconnue.');
  assert.equal(STATE_LABEL.RECORDING, 'ENREGISTREMENT EN COURS');
  assert.deepEqual([formatElapsed(0), formatElapsed(65_000), formatElapsed(3_725_000), formatBytes(512), formatBytes(2 * 1048576)], ['0:00', '1:05', '1:02:05', '512 o', '2.0 Mo']);
  assert.equal(isActive('RECORDING'), true); assert.equal(isActive('READY'), false);
});

test('nothing is captured until start(); screen start → chunks in order → stop → finalize READY; tracks stopped', async () => {
  const env = makeEnv(); const port = makePort();
  const c = new RecorderCaptureController({ port, env, timesliceMs: 250 });
  assert.deepEqual([env.calls.display, env.calls.user, port.calls.length, c.snapshot.state], [0, 0, 0, 'IDLE'], 'no capture at construction');
  await c.start({ source: 'SCREEN', title: 'Démo' });
  assert.equal(c.snapshot.state, 'RECORDING');
  assert.equal(env.MediaRecorder.last.timeslice, 250, 'timesliced: chunks, not one blob');
  assert.equal(env.MediaRecorder.last.mimeType, 'video/webm;codecs=vp9,opus');
  assert.deepEqual(port.calls[0], ['createSession', { type: 'SCREEN', title: 'Démo', mimeType: 'video/webm;codecs=vp9,opus' }]);
  for (let i = 0; i < 5; i++) { env.MediaRecorder.last.emit(1000); await flush(); await flush(); } // one chunk per timeslice
  env.tick(4000);
  await c.stop();
  assert.deepEqual(port.chunks, [0, 1, 2, 3, 4, 5], 'sequential seq, final chunk flushed before finalize');
  const fin = port.calls.find(x => x[0] === 'finalize');
  assert.deepEqual([fin[1].durationMs, fin[1].width, fin[1].height], [4000, 1280, 720]);
  assert.equal(c.snapshot.state, 'READY');
  assert.ok(allStopped(env), 'all tracks stopped');
  assert.equal(c.snapshot.bytesQueued, 0);
  assert.equal(c.snapshot.maxQueuedBytesSeen <= 1010, true, 'queue held ~one chunk at a time');
});

test('camera + mic; screen + mic (two acquisitions); one active recording; STOP twice is a no-op', async () => {
  const env = makeEnv(); const port = makePort();
  const c = new RecorderCaptureController({ port, env });
  await c.start({ source: 'CAMERA', withMic: true });
  assert.deepEqual([env.acquired.map(t => t.kind).sort(), port.calls[0][1].type], [['audio', 'video'], 'CAMERA_WITH_MIC']);
  assert.ok(c.snapshot.previewStream, 'camera preview stream');
  await assert.rejects(c.start({ source: 'SCREEN' }), (e) => e.code === 'ALREADY_RECORDING');
  env.MediaRecorder.last.emit(100); await flush();
  await Promise.all([c.stop(), c.stop()]);
  assert.equal(port.calls.filter(x => x[0] === 'finalize').length, 1);
  assert.ok(allStopped(env));
  const env2 = makeEnv(); const c2 = new RecorderCaptureController({ port: makePort(), env: env2 });
  await c2.start({ source: 'SCREEN', withMic: true });
  assert.deepEqual([env2.calls.display, env2.calls.user, env2.acquired.length], [1, 1, 2]);
  await c2.cancel();
  assert.ok(allStopped(env2));
});

test('permission denied (screen, camera, mic after screen granted): FAILED / PERMISSION_DENIED, no session, every acquired track stopped', async () => {
  for (const [opts, start] of [[{ displayDenied: true }, { source: 'SCREEN' }], [{ cameraDenied: true }, { source: 'CAMERA', withMic: true }], [{ micDenied: true }, { source: 'SCREEN', withMic: true }]]) {
    const env = makeEnv(opts); const port = makePort();
    const c = new RecorderCaptureController({ port, env });
    await c.start(start);
    assert.deepEqual([c.snapshot.state, c.snapshot.error], ['FAILED', 'PERMISSION_DENIED'], JSON.stringify(opts));
    assert.equal(port.calls.length, 0, 'no session created');
    assert.ok(allStopped(env), 'the already-granted screen track is stopped too');
  }
  const noFormat = makeEnv({ recorder: makeRecorderClass({ supported: [] }) });
  const c = new RecorderCaptureController({ port: makePort(), env: noFormat });
  await c.start({ source: 'CAMERA' });
  assert.deepEqual([c.snapshot.state, c.snapshot.error], ['FAILED', 'UNSUPPORTED_FORMAT']);
  assert.ok(allStopped(noFormat));
});

test('cancel: capture stops, queue dropped, server session cancelled, tracks stopped; unmount (dispose) does the same', async () => {
  const env = makeEnv(); const port = makePort();
  const c = new RecorderCaptureController({ port, env });
  await c.start({ source: 'SCREEN' });
  env.MediaRecorder.last.emit(500);
  await c.cancel();
  assert.equal(c.snapshot.state, 'CANCELLED');
  assert.ok(port.calls.some(x => x[0] === 'cancel'));
  assert.equal(port.calls.some(x => x[0] === 'finalize'), false);
  assert.ok(allStopped(env));
  const env2 = makeEnv(); const port2 = makePort();
  const d = new RecorderCaptureController({ port: port2, env: env2 });
  await d.start({ source: 'CAMERA', withMic: true });
  d.dispose();
  await flush(); await flush();
  assert.ok(allStopped(env2), 'unmount stops every track');
  assert.ok(port2.calls.some(x => x[0] === 'cancel'), 'unmount cancels the open session');
});

test('the browser / OS ends the screen share → STOP + finalize, never stuck RECORDING', async () => {
  const env = makeEnv(); const port = makePort();
  const c = new RecorderCaptureController({ port, env });
  await c.start({ source: 'SCREEN' });
  env.MediaRecorder.last.emit(200); await flush();
  env.acquired[0].endByBrowser();
  for (let i = 0; i < 10 && c.snapshot.state !== 'READY'; i++) await flush();
  assert.equal(c.snapshot.state, 'READY');
  assert.ok(port.calls.some(x => x[0] === 'finalize'));
});

test('pause / resume only when supported; paused time excluded from the duration; no Pause when unsupported', async () => {
  const env = makeEnv(); const port = makePort();
  const c = new RecorderCaptureController({ port, env });
  await c.start({ source: 'CAMERA' });
  assert.equal(c.snapshot.canPause, true);
  env.tick(1000); c.pause(); assert.equal(c.snapshot.state, 'PAUSED'); assert.equal(env.MediaRecorder.last.state, 'paused');
  env.tick(5000); c.resume(); assert.equal(c.snapshot.state, 'RECORDING');
  env.tick(1000);
  await c.stop();
  assert.equal(port.calls.find(x => x[0] === 'finalize')[1].durationMs, 2000, '5 s of pause not counted');
  const env2 = makeEnv({ recorder: makeRecorderClass({ pausable: false }) });
  const c2 = new RecorderCaptureController({ port: makePort(), env: env2 });
  await c2.start({ source: 'CAMERA' });
  assert.equal(c2.snapshot.canPause, false);
  c2.pause(); assert.equal(c2.snapshot.state, 'RECORDING', 'no fake pause');
  await c2.cancel();
});

test('zero chunk → the server answers EMPTY_RECORDING → FAILED (never READY); backend error mid-capture → FAILED, session cancelled, tracks stopped', async () => {
  const env = makeEnv({ recorder: makeRecorderClass({ finalBlob: false }) });
  const port = makePort({ finalizeStatus: 'FAILED' });
  const c = new RecorderCaptureController({ port, env });
  await c.start({ source: 'SCREEN' });
  await c.stop();
  assert.deepEqual([c.snapshot.state, c.snapshot.error, port.chunks.length], ['FAILED', 'EMPTY_RECORDING', 0]);
  const env2 = makeEnv(); const port2 = makePort({ failAppendAt: 2 });
  const c2 = new RecorderCaptureController({ port: port2, env: env2 });
  await c2.start({ source: 'CAMERA' });
  for (let i = 0; i < 4; i++) env2.MediaRecorder.last.emit(100);
  for (let i = 0; i < 10 && c2.snapshot.state !== 'FAILED'; i++) await flush();
  assert.deepEqual([c2.snapshot.state, c2.snapshot.error], ['FAILED', 'DISK_FULL']);
  assert.ok(allStopped(env2));
  assert.ok(port2.calls.some(x => x[0] === 'cancel'));
  assert.equal(env2.MediaRecorder.last.state, 'inactive', 'MediaRecorder stopped: no new data after the failure');
});

test('bounded renderer memory: slow storage + small queue cap → BACKPRESSURE stop instead of unbounded growth', async () => {
  const env = makeEnv(); const port = makePort({ delayAppend: 30 });
  const c = new RecorderCaptureController({ port, env, maxQueuedBytes: 5000 });
  await c.start({ source: 'SCREEN' });
  for (let i = 0; i < 20; i++) env.MediaRecorder.last.emit(1000);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual([c.snapshot.state, c.snapshot.error], ['FAILED', 'BACKPRESSURE']);
  assert.ok(c.snapshot.maxQueuedBytesSeen <= 5000, `queue peak ${c.snapshot.maxQueuedBytesSeen} ≤ cap`);
  assert.ok(allStopped(env));
});

// ── [MASTER WS2] device selector ──
test('listDevices: returns mic+camera inputs; empty when the env cannot enumerate; never opens a device', async () => {
  const devices = [
    { deviceId: 'cam1', kind: 'videoinput', label: 'HD Webcam' },
    { deviceId: 'mic1', kind: 'audioinput', label: '' },               // label empty (pre-permission)
    { deviceId: 'spk1', kind: 'audiooutput', label: 'Speakers' },      // output ignored
  ];
  const env = makeEnv({ devices }); const port = makePort();
  const c = new RecorderCaptureController({ port, env });
  const list = await c.listDevices();
  assert.deepEqual(list, [{ deviceId: 'cam1', label: 'HD Webcam', kind: 'videoinput' }, { deviceId: 'mic1', label: '', kind: 'audioinput' }]);
  assert.deepEqual([env.calls.display, env.calls.user], [0, 0], 'enumeration never opens a device');
  // older env without enumerateDevices → []
  assert.deepEqual(await new RecorderCaptureController({ port, env: makeEnv() }).listDevices(), []);
});

test('a chosen deviceId becomes an EXACT getUserMedia constraint; no choice → browser default', async () => {
  const env = makeEnv({ devices: [{ deviceId: 'cam2', kind: 'videoinput', label: 'Cam' }, { deviceId: 'mic2', kind: 'audioinput', label: 'Mic' }] });
  const c = new RecorderCaptureController({ port: makePort(), env, timesliceMs: 250 });
  await c.start({ source: 'CAMERA', withMic: true, cameraDeviceId: 'cam2', micDeviceId: 'mic2' });
  assert.deepEqual(env.lastConstraints.at(-1), { video: { deviceId: { exact: 'cam2' } }, audio: { deviceId: { exact: 'mic2' } } });
  await c.stop();
  // no selection → plain booleans (unchanged legacy behaviour)
  const env2 = makeEnv(); const c2 = new RecorderCaptureController({ port: makePort(), env: env2, timesliceMs: 250 });
  await c2.start({ source: 'CAMERA', withMic: true });
  assert.deepEqual(env2.lastConstraints.at(-1), { video: true, audio: true });
  await c2.stop();
});

test('screen + chosen mic: the mic constraint carries the deviceId, screen video is untouched', async () => {
  const env = makeEnv({ devices: [{ deviceId: 'mic3', kind: 'audioinput', label: 'Mic' }] });
  const c = new RecorderCaptureController({ port: makePort(), env, timesliceMs: 250 });
  await c.start({ source: 'SCREEN', withMic: true, micDeviceId: 'mic3' });
  assert.deepEqual(env.lastConstraints.at(-1), { audio: { deviceId: { exact: 'mic3' } }, video: false }, 'mic getUserMedia uses the chosen device');
  await c.stop();
});
