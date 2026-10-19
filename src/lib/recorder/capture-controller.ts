// Native Recorder — RECORDER-1 capture controller (framework-free; React wraps it in RecorderPanel).
//
// Capture starts ONLY from start() (a user gesture in the UI) — never at load. Every acquired track is registered at
// once, so stop / cancel / error / unmount / a partial permission refusal always stop ALL of them. MediaRecorder runs
// with a timeslice: each chunk is queued and sent in order (seq 0,1,2…) to the RecorderPort; the queue is BOUNDED
// (maxQueuedBytes) — if storage cannot keep up, the capture stops with BACKPRESSURE instead of growing in RAM. The
// renderer never holds the whole recording. If the person ends the screen share from the browser / OS
// (track 'ended'), the capture is STOPPED and finalized (what was captured is kept), never left "RECORDING".
import {
  RecorderUiError, captureErrorCode, isActive, pickRecorderMime, recordingType,
  type CaptureState, type RecorderPort, type RecordingDto, type RecordingSource,
} from './recorder-contracts.ts';

export interface CaptureEnv {
  mediaDevices: {
    getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
    getDisplayMedia(c: DisplayMediaStreamOptions): Promise<MediaStream>;
    // [MASTER WS2] optional: device enumeration for the selector. Absent in older envs / fakes → no selector offered.
    enumerateDevices?(): Promise<MediaDeviceInfo[]>;
  };
  MediaRecorder: { new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder; isTypeSupported(mime: string): boolean };
  now(): number;
}

// [MASTER WS2] A device option for the selector. `label` is empty until a permission has been granted once (browser
// privacy rule); the UI shows a generic name in that case. `deviceId` is opaque and passed straight back as a constraint.
export interface MediaDeviceOption { deviceId: string; label: string; kind: 'audioinput' | 'videoinput' }
export interface CaptureSnapshot {
  state: CaptureState; source: RecordingSource | null; withMic: boolean; mimeType: string | null; startedAt: number | null; elapsedMs: number;
  bytesSent: number; bytesQueued: number; maxQueuedBytesSeen: number; chunksSent: number; canPause: boolean; error: string | null; recording: RecordingDto | null;
  previewStream: MediaStream | null;
}
export const DEFAULT_TIMESLICE_MS = 1000;
export const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024; // PROVISIONAL: ~30 s of 1080p WebM waiting for storage

export function browserCaptureEnv(): CaptureEnv | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof MediaRecorder === 'undefined') return null;
  const md = navigator.mediaDevices;
  return {
    mediaDevices: {
      getUserMedia: (c) => md.getUserMedia(c),
      getDisplayMedia: (c) => md.getDisplayMedia(c),
      enumerateDevices: typeof md.enumerateDevices === 'function' ? () => md.enumerateDevices() : undefined,
    },
    MediaRecorder, now: () => performance.now(),
  };
}

export class RecorderCaptureController {
  private port: RecorderPort; private env: CaptureEnv; private timesliceMs: number; private maxQueuedBytes: number;
  private listeners = new Set<(s: CaptureSnapshot) => void>();
  private tracks: MediaStreamTrack[] = [];
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private session: { recordingId: string; sessionToken: string } | null = null;
  private queue: { seq: number; blob: Blob }[] = [];
  private nextSeq = 0; private pumping: Promise<void> | null = null; private discard = false; private stopping: Promise<void> | null = null;
  private pausedAt: number | null = null; private pausedTotal = 0;
  private videoSize: { width?: number; height?: number } = {}; // read while the track is live (an ended track reports nothing)
  private snap: CaptureSnapshot = { state: 'IDLE', source: null, withMic: false, mimeType: null, startedAt: null, elapsedMs: 0, bytesSent: 0, bytesQueued: 0, maxQueuedBytesSeen: 0, chunksSent: 0, canPause: false, error: null, recording: null, previewStream: null };

  constructor({ port, env, timesliceMs = DEFAULT_TIMESLICE_MS, maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES }: { port: RecorderPort; env: CaptureEnv; timesliceMs?: number; maxQueuedBytes?: number }) {
    this.port = port; this.env = env; this.timesliceMs = timesliceMs; this.maxQueuedBytes = maxQueuedBytes;
  }
  subscribe(fn: (s: CaptureSnapshot) => void): () => void { this.listeners.add(fn); fn(this.snapshot); return () => { this.listeners.delete(fn); }; }
  get snapshot(): CaptureSnapshot { return { ...this.snap, elapsedMs: this.elapsed() }; }
  private set(patch: Partial<CaptureSnapshot>) { this.snap = { ...this.snap, ...patch }; const s = this.snapshot; for (const l of this.listeners) l(s); }
  private elapsed(): number {
    if (this.snap.startedAt === null) return 0;
    const end = this.pausedAt ?? (isActive(this.snap.state) ? this.env.now() : this.endedAt ?? this.env.now());
    return Math.max(0, end - this.snap.startedAt - this.pausedTotal);
  }
  private endedAt: number | null = null;
  /** Tracks currently held (for tests / diagnostics). */
  heldTracks(): readonly MediaStreamTrack[] { return this.tracks.filter(t => t.readyState !== 'ended'); }

  private stopTracks() {
    for (const t of this.tracks) { try { t.stop(); } catch { /* already stopped */ } }
    this.set({ previewStream: null });
  }
  private hold(stream: MediaStream) { for (const t of stream.getTracks()) this.tracks.push(t); }

  /**
   * [MASTER WS2] Lists the mic / camera devices for the selector. Never opens a device (no getUserMedia): it only
   * reads enumerateDevices(), so it is safe to call before any permission. Returns [] when the env cannot enumerate.
   * Labels are empty until the user has granted a permission once — the UI supplies a generic name in that case.
   */
  async listDevices(): Promise<MediaDeviceOption[]> {
    const enumerate = this.env.mediaDevices.enumerateDevices;
    if (typeof enumerate !== 'function') return [];
    try {
      const devices = await enumerate.call(this.env.mediaDevices);
      return devices
        .filter(d => d.kind === 'audioinput' || d.kind === 'videoinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label ?? '', kind: d.kind as 'audioinput' | 'videoinput' }));
    } catch { return []; }
  }

  async start({ source, withMic = false, title, micDeviceId, cameraDeviceId }: { source: RecordingSource; withMic?: boolean; title?: string; micDeviceId?: string; cameraDeviceId?: string }): Promise<void> {
    if (isActive(this.snap.state)) throw new RecorderUiError('ALREADY_RECORDING', 'Un enregistrement est déjà en cours.');
    if (source !== 'SCREEN' && source !== 'CAMERA') throw new RecorderUiError('CAPTURE_FAILED', 'Source inconnue.');
    this.reset();
    this.set({ state: 'ACQUIRING', source, withMic, error: null, recording: null });
    // [MASTER WS2] A chosen deviceId becomes an EXACT constraint; no selection → the browser default (unchanged behaviour).
    const micAudio: MediaTrackConstraints | boolean = micDeviceId ? { deviceId: { exact: micDeviceId } } : true;
    const camVideo: MediaTrackConstraints | boolean = cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true;
    let stream: MediaStream;
    try {
      if (source === 'SCREEN') {
        const display = await this.env.mediaDevices.getDisplayMedia({ video: true, audio: false });
        this.hold(display);
        const tracks = [...display.getVideoTracks()];
        if (withMic) { const mic = await this.env.mediaDevices.getUserMedia({ audio: micAudio, video: false }); this.hold(mic); tracks.push(...mic.getAudioTracks()); }
        stream = new MediaStream(tracks);
      } else {
        stream = await this.env.mediaDevices.getUserMedia({ video: camVideo, audio: withMic ? micAudio : false });
        this.hold(stream);
      }
      if (!stream.getVideoTracks().length) throw Object.assign(new Error('no video track'), { name: 'NotFoundError' });
    } catch (e) { this.stopTracks(); this.set({ state: 'FAILED', error: captureErrorCode(e) }); return; }
    if (!isActive(this.snap.state)) { this.stopTracks(); return; } // cancelled / disposed while the permission prompt was open
    this.stream = stream;
    const mimeType = pickRecorderMime((m) => this.env.MediaRecorder.isTypeSupported(m));
    if (!mimeType) { this.stopTracks(); this.set({ state: 'FAILED', error: 'UNSUPPORTED_FORMAT' }); return; }
    this.set({ state: 'STARTING', mimeType, previewStream: source === 'CAMERA' ? stream : null });
    try {
      const s = await this.port.createSession({ type: recordingType(source, withMic), title, mimeType });
      this.session = { recordingId: s.recordingId, sessionToken: s.sessionToken };
      if (!isActive(this.snap.state)) { await this.abandonSession(); this.stopTracks(); return; }
      const rec = new this.env.MediaRecorder(stream, { mimeType });
      this.recorder = rec;
      rec.ondataavailable = (ev: BlobEvent) => this.enqueue(ev.data);
      rec.onerror = () => { void this.fail('RECORDER_ERROR'); };
      // the person ends the share from the browser / OS, or the camera disappears: stop and keep what was captured
      for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => { if (this.snap.state === 'RECORDING' || this.snap.state === 'PAUSED') void this.stop(); }, { once: true });
      const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
      this.videoSize = { ...(Number.isSafeInteger(settings.width) ? { width: settings.width } : {}), ...(Number.isSafeInteger(settings.height) ? { height: settings.height } : {}) };
      await this.port.markStarted(s.recordingId, s.sessionToken);
      rec.start(this.timesliceMs);
      this.set({ state: 'RECORDING', startedAt: this.env.now(), canPause: typeof rec.pause === 'function' && typeof rec.resume === 'function' });
    } catch (e) { await this.fail(e instanceof RecorderUiError ? e.code : (e as { code?: string })?.code ?? 'UPLOAD_FAILED'); }
  }

  private enqueue(blob: Blob) {
    if (this.discard || !blob || blob.size === 0) return;
    const queued = this.snap.bytesQueued + blob.size;
    if (queued > this.maxQueuedBytes) { void this.fail('BACKPRESSURE'); return; }
    this.queue.push({ seq: this.nextSeq++, blob });
    this.set({ bytesQueued: queued, maxQueuedBytesSeen: Math.max(this.snap.maxQueuedBytesSeen, queued) });
    if (!this.pumping) this.pumping = this.pump().finally(() => { this.pumping = null; });
  }
  private async pump() {
    while (this.queue.length && !this.discard && this.session) {
      const item = this.queue[0];
      try { await this.port.appendChunk(this.session.recordingId, this.session.sessionToken, item.seq, item.blob); } catch (e) { await this.fail((e as { code?: string })?.code ?? 'UPLOAD_FAILED'); return; }
      this.queue.shift(); // the blob is released once stored
      this.set({ bytesQueued: this.snap.bytesQueued - item.blob.size, bytesSent: this.snap.bytesSent + item.blob.size, chunksSent: this.snap.chunksSent + 1 });
    }
  }

  pause() {
    if (this.snap.state !== 'RECORDING' || !this.recorder || !this.snap.canPause) return;
    this.recorder.pause(); this.pausedAt = this.env.now(); this.set({ state: 'PAUSED' });
  }
  resume() {
    if (this.snap.state !== 'PAUSED' || !this.recorder) return;
    this.recorder.resume(); if (this.pausedAt !== null) this.pausedTotal += this.env.now() - this.pausedAt; this.pausedAt = null; this.set({ state: 'RECORDING' });
  }

  /** STOP: no new data is captured after this call; the last chunk is flushed, the queue drained, then finalized. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.snap.state !== 'RECORDING' && this.snap.state !== 'PAUSED') return Promise.resolve();
    this.stopping = this.doStop().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  private async doStop() {
    const rec = this.recorder;
    if (this.pausedAt !== null) { this.pausedTotal += this.env.now() - this.pausedAt; this.pausedAt = null; }
    this.endedAt = this.env.now();
    this.set({ state: 'STOPPING' });
    if (rec && rec.state !== 'inactive') await new Promise<void>((resolve) => { rec.addEventListener('stop', () => resolve(), { once: true }); rec.stop(); });
    this.stopTracks();
    while (this.pumping) await this.pumping;
    if (this.snap.state !== 'STOPPING' || !this.session) return; // failed while flushing
    this.set({ state: 'FINALIZING' });
    try {
      const out = await this.port.finalize(this.session.recordingId, this.session.sessionToken, {
        durationMs: Math.round(this.elapsed()), ...this.videoSize,
      });
      this.session = null;
      this.set(out.status === 'READY' ? { state: 'READY', recording: out.recording, error: null } : { state: 'FAILED', recording: out.recording, error: out.error ?? 'FINALIZE_FAILED' });
    } catch (e) { this.session = null; this.set({ state: 'FAILED', error: (e as { code?: string })?.code ?? 'FINALIZE_FAILED' }); }
  }

  /** CANCEL: capture stops, queued data is dropped, the server removes the partial file. */
  async cancel(): Promise<void> {
    if (!isActive(this.snap.state) || this.snap.state === 'FINALIZING') return;
    this.discard = true;
    this.endedAt = this.env.now();
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* inactive */ } }
    this.stopTracks();
    this.queue = []; this.set({ state: 'CANCELLED', bytesQueued: 0 });
    while (this.pumping) await this.pumping;
    await this.abandonSession();
  }
  private async abandonSession() {
    const s = this.session; this.session = null;
    if (s) { try { await this.port.cancel(s.recordingId, s.sessionToken); } catch { /* the server sweeps abandoned sessions */ } }
  }
  private async fail(code: string) {
    if (!isActive(this.snap.state) && this.snap.state !== 'IDLE') return;
    this.discard = true;
    this.endedAt = this.env.now();
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* inactive */ } }
    this.stopTracks();
    this.queue = [];
    this.set({ state: 'FAILED', error: code, bytesQueued: 0 });
    await this.abandonSession();
  }
  /** Unmount: whatever happens, every track is stopped and an open session is cancelled. */
  dispose() {
    if (isActive(this.snap.state)) void this.cancel(); else this.stopTracks();
    this.listeners.clear();
  }
  private reset() {
    this.tracks = []; this.stream = null; this.videoSize = {}; this.recorder = null; this.session = null; this.queue = []; this.nextSeq = 0; this.discard = false; this.pausedAt = null; this.pausedTotal = 0; this.endedAt = null;
    this.snap = { ...this.snap, startedAt: null, bytesSent: 0, bytesQueued: 0, maxQueuedBytesSeen: 0, chunksSent: 0, canPause: false, mimeType: null };
  }
}
