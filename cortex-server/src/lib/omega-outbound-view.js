import crypto from 'node:crypto';
import * as capture from './omega-capture.js';

export const OMEGA_V2_VIEW_LIMITS = Object.freeze({
  maxFrameBytes: 8 * 1024 * 1024,
  maxDimension: 7680,
  maxFps: 2,
  minFrameIntervalMs: 500,
  maxStreamDurationMs: 10 * 60_000,
  maxQueuedFrames: 1,
  mimeType: 'image/png',
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class OmegaOutboundViewError extends Error {
  constructor(code, detail) { super(code); this.name = 'OmegaOutboundViewError'; this.code = code; this.detail = detail; }
}

function fail(code, detail) { throw new OmegaOutboundViewError(code, detail); }

export function inspectPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_MAGIC)
    || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') fail('FRAME_INVALID');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > OMEGA_V2_VIEW_LIMITS.maxDimension || height > OMEGA_V2_VIEW_LIMITS.maxDimension) {
    fail('FRAME_INVALID');
  }
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  if (![0, 2, 3, 4, 6].includes(colorType) || ![1, 2, 4, 8, 16].includes(bitDepth)
    || buffer[26] !== 0 || buffer[27] !== 0 || ![0, 1].includes(buffer[28])) fail('FRAME_INVALID');
  let offset = 8;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > OMEGA_V2_VIEW_LIMITS.maxFrameBytes || offset + 12 + length > buffer.length) fail('FRAME_INVALID');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || offset + 12 !== buffer.length) fail('FRAME_INVALID');
      sawEnd = true;
      break;
    }
    offset += 12 + length;
  }
  if (!sawData || !sawEnd) fail('FRAME_INVALID');
  return { width, height };
}

function checkFrame(frame) {
  if (!frame || !Buffer.isBuffer(frame.buffer) || frame.buffer.length < 24) fail('FRAME_INVALID');
  if (frame.buffer.length > OMEGA_V2_VIEW_LIMITS.maxFrameBytes) fail('FRAME_TOO_LARGE');
  const dimensions = inspectPng(frame.buffer);
  if (dimensions.width !== frame.width || dimensions.height !== frame.height) fail('FRAME_INVALID');
}

export function createOmegaOutboundViewManager(provider = capture) {
  const streams = new Map();
  const stopListeners = new Set();

  async function stop(sessionId, reason = 'stopped', expectedStreamId = null) {
    const stream = streams.get(sessionId);
    if (!stream) return { stopped: false, status: 'STOPPED', reason };
    if (expectedStreamId && stream.streamId !== expectedStreamId) fail('WRONG_STREAM');
    streams.delete(sessionId);
    stream.stopped = true;
    if (stream.expiryTimer) clearTimeout(stream.expiryTimer);
    stream.latestFrame?.fill(0);
    stream.latestFrame = null;
    await Promise.allSettled([...stopListeners].map(listener => listener(sessionId, reason, stream)));
    await provider.showSessionIndicator('stop', sessionId, stream.controllerDeviceId, stream.expiresAt).catch(() => {});
    return { stopped: true, status: 'STOPPED', streamId: stream.streamId, reason };
  }

  async function start(session, screenIndex) {
    if (!Number.isInteger(screenIndex) || screenIndex < 0 || screenIndex > 63) fail('SCREEN_INDEX_INVALID');
    if (streams.has(session.id)) fail('VIEW_ALREADY_STARTED');
    const screens = await provider.listScreens();
    if (!Array.isArray(screens) || screenIndex >= screens.length) fail('SCREEN_INDEX_INVALID');
    const startedAt = new Date();
    const maxEnd = startedAt.getTime() + OMEGA_V2_VIEW_LIMITS.maxStreamDurationMs;
    const expiresAt = new Date(Math.min(maxEnd, Date.parse(session.expires_at))).toISOString();
    const stream = {
      sessionId: session.id, controllerDeviceId: session.remote_device_id,
      hostDeviceId: session.local_device_id, streamId: crypto.randomUUID(), screenIndex,
      startedAt: startedAt.toISOString(), expiresAt, status: 'VIEW_STARTING', sequence: 0,
      lastFrameAt: 0, inFlight: false, latestFrame: null, stopped: false, expiryTimer: null,
    };
    const indicator = await provider.showSessionIndicator('start', session.id, session.remote_device_id, expiresAt,
      () => stop(session.id, 'remote_local_stop')).catch(() => ({ ok: false }));
    if (!indicator?.ok) fail('REMOTE_CONSENT_UNAVAILABLE');
    streams.set(session.id, stream);
    stream.expiryTimer = setTimeout(() => void stop(session.id, 'stream_expired'),
      Math.max(1, Date.parse(expiresAt) - Date.now()));
    stream.expiryTimer.unref?.();
    return { streamId: stream.streamId, screenIndex, screens, startedAt: stream.startedAt,
      expiresAt, status: stream.status, limits: OMEGA_V2_VIEW_LIMITS };
  }

  function status(sessionId, expectedStreamId = null) {
    const stream = streams.get(sessionId);
    if (!stream) return { status: 'STOPPED', reason: 'REMOTE_STOPPED' };
    if (expectedStreamId && stream.streamId !== expectedStreamId) fail('WRONG_STREAM');
    if (Date.parse(stream.expiresAt) <= Date.now()) {
      void stop(sessionId, 'stream_expired');
      return { status: 'STOPPED', streamId: stream.streamId, reason: 'STREAM_EXPIRED' };
    }
    return { status: stream.status, streamId: stream.streamId, screenIndex: stream.screenIndex,
      startedAt: stream.startedAt, expiresAt: stream.expiresAt, sequence: stream.sequence,
      lastFrameAt: stream.lastFrameAt ? new Date(stream.lastFrameAt).toISOString() : null };
  }

  async function frame(sessionId, expectedStreamId) {
    const stream = streams.get(sessionId);
    if (!stream) fail('REMOTE_STOPPED');
    if (stream.streamId !== expectedStreamId) fail('WRONG_STREAM');
    if (Date.parse(stream.expiresAt) <= Date.now()) { await stop(sessionId, 'stream_expired'); fail('STREAM_EXPIRED'); }
    const elapsed = Date.now() - stream.lastFrameAt;
    if (stream.inFlight || (stream.lastFrameAt && elapsed < OMEGA_V2_VIEW_LIMITS.minFrameIntervalMs)) {
      fail('RATE_LIMITED', { retryAfterMs: Math.max(1, OMEGA_V2_VIEW_LIMITS.minFrameIntervalMs - elapsed) });
    }
    stream.inFlight = true;
    try {
      const captured = await provider.captureFrame(stream.screenIndex);
      checkFrame(captured);
      if (stream.stopped || streams.get(sessionId) !== stream) {
        captured.buffer.fill(0);
        fail('REMOTE_STOPPED');
      }
      stream.sequence += 1;
      stream.lastFrameAt = Date.now();
      stream.status = 'VIEWING';
      stream.latestFrame?.fill(0);
      stream.latestFrame = captured.buffer;
      return { ...captured, mimeType: OMEGA_V2_VIEW_LIMITS.mimeType, streamId: stream.streamId,
        frameId: crypto.randomUUID(), sequence: stream.sequence, timestamp: new Date().toISOString(),
        screenIndex: stream.screenIndex };
    } finally {
      stream.inFlight = false;
    }
  }

  async function stopForController(controllerDeviceId, reason) {
    const targets = [...streams.values()].filter(value => value.controllerDeviceId === controllerDeviceId);
    await Promise.allSettled(targets.map(value => stop(value.sessionId, reason)));
    return targets.length;
  }

  async function stopAll(reason = 'server_stop') {
    const ids = [...streams.keys()];
    await Promise.allSettled(ids.map(id => stop(id, reason)));
    return ids.length;
  }

  function onStop(listener) { stopListeners.add(listener); return () => stopListeners.delete(listener); }

  return { start, status, frame, stop, stopForController, stopAll, onStop, _streams: streams };
}
