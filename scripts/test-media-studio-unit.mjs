// Media Studio V1 — unit tests of the frontend pure modules (Node type stripping):
// preview model (must mirror the export plan) and the Media Reader → studio fetch bridge.
// Usage: node --test scripts/test-media-studio-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fadeEnvelope, formatTimecode, playableVolume, previewFrameAt, sequenceDurationMs } from '../src/lib/media-studio/preview.ts';
import { BRIDGE_MAX_BYTES, bridgeFileName, fetchMediaBlob } from '../src/lib/media-studio/import.ts';

const clip = (id, trackId, assetId, inMs, outMs, extra = {}) => ({ id, trackId, assetId, inMs, outMs, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, ...(trackId === 'A1' ? { startMs: 0 } : {}), ...extra });
const project = (clips, tracks = {}) => ({
  assets: [
    { id: 'v', kind: 'video', hasAudio: true }, { id: 'n', kind: 'video', hasAudio: false }, { id: 'i', kind: 'image', hasAudio: false }, { id: 'a', kind: 'audio', hasAudio: true },
  ],
  tracks: [{ id: 'V1', muted: false, volume: 1, ...tracks.V1 }, { id: 'A1', muted: false, volume: 1, ...tracks.A1 }],
  clips,
});

test('sequence: video clips back to back, offsets inside the source, end of sequence', () => {
  const p = project([clip('c1', 'V1', 'v', 500, 1500), clip('c2', 'V1', 'i', 0, 2000), clip('c3', 'V1', 'v', 0, 1000)]);
  assert.equal(sequenceDurationMs(p), 4000);
  assert.deepEqual([0, 999, 1000, 2999, 3000, 3999].map(t => previewFrameAt(p, t).video?.clipId), ['c1', 'c1', 'c2', 'c2', 'c3', 'c3']);
  assert.equal(previewFrameAt(p, 250).video.offsetMs, 750, 'trim in-point respected');
  assert.equal(previewFrameAt(p, 1200).video.kind, 'image');
  assert.equal(previewFrameAt(p, 1200).video.gain, 0, 'an image has no sound');
  const end = previewFrameAt(p, 4000);
  assert.equal(end.video, null); assert.equal(end.ended, true);
});

test('audio: absolute position, cut at the sequence end, muted / zero volume / muted track silent', () => {
  const p = project([clip('v1', 'V1', 'v', 0, 3000), clip('a1', 'A1', 'a', 1000, 5000, { startMs: 2000 })]);
  assert.deepEqual(previewFrameAt(p, 1999).audio, []);
  assert.deepEqual(previewFrameAt(p, 2500).audio.map(a => [a.clipId, a.offsetMs]), [['a1', 1500]]);
  assert.equal(previewFrameAt(p, 3000).ended, true, 'audio past the sequence is not played (export: duration=first)');
  assert.deepEqual(previewFrameAt(project([clip('v1', 'V1', 'v', 0, 3000), clip('a1', 'A1', 'a', 0, 2000, { muted: true })]), 500).audio, []);
  assert.deepEqual(previewFrameAt(project([clip('v1', 'V1', 'v', 0, 3000), clip('a1', 'A1', 'a', 0, 2000, { volume: 0 })]), 500).audio, []);
  assert.deepEqual(previewFrameAt(project([clip('v1', 'V1', 'v', 0, 3000), clip('a1', 'A1', 'a', 0, 2000)], { A1: { muted: true } }), 500).audio, []);
});

test('gains mirror the export: clip × track, fades, muted clip / track / silent source', () => {
  const p = project([clip('v1', 'V1', 'v', 0, 2000, { volume: 1.5, fadeInMs: 500, fadeOutMs: 500 }), clip('a1', 'A1', 'a', 0, 2000, { volume: 0.5 })], { V1: { volume: 0.8 }, A1: { volume: 2 } });
  assert.equal(previewFrameAt(p, 0).video.gain, 0);
  assert.ok(Math.abs(previewFrameAt(p, 250).video.gain - 0.6) < 1e-9, '1.5 × 0.8 × 0.5 (fade in)');
  assert.ok(Math.abs(previewFrameAt(p, 1000).video.gain - 1.2) < 1e-9);
  assert.ok(Math.abs(previewFrameAt(p, 1750).video.gain - 0.6) < 1e-9, 'fade out');
  assert.equal(previewFrameAt(p, 1000).audio[0].gain, 1);
  assert.equal(previewFrameAt(project([clip('v1', 'V1', 'v', 0, 1000, { muted: true })]), 10).video.gain, 0);
  assert.equal(previewFrameAt(project([clip('v1', 'V1', 'v', 0, 1000)], { V1: { muted: true } }), 10).video.gain, 0);
  assert.equal(previewFrameAt(project([clip('v1', 'V1', 'n', 0, 1000)]), 10).video.gain, 0, 'video without audio stream');
  assert.equal(playableVolume(1.2), 1); assert.equal(playableVolume(-1), 0); assert.equal(playableVolume(0.4), 0.4);
  assert.equal(fadeEnvelope(100, 1000, 0, 0), 1);
  assert.equal(formatTimecode(65_432), '1:05.4');
});

test('export / preview parity: same duration formula and same rule for audio past the end as the server plan', () => {
  const server = fs.readFileSync('cortex-server/src/lib/media-studio.js', 'utf8');
  assert.match(server, /amix=inputs=\$\{mixed\.length \+ 1\}:duration=first/, 'server cuts the mix at the sequence end');
  assert.match(server, /const gain = \(vTrack\.muted \|\| c\.muted\) \? 0 : c\.volume \* vTrack\.volume;/, 'server video gain = clip × track');
  assert.match(server, /volume=\$\{\(c\.volume \* aTrack\.volume\)\.toFixed\(2\)\}/, 'server audio gain = clip × track');
});

function fakeResponse({ status = 200, body = new Uint8Array(0), headers = {}, chunks = null }) {
  const h = new Headers(headers);
  const stream = new ReadableStream({ start(c) { for (const ch of chunks ?? [body]) c.enqueue(ch); c.close(); } });
  return { ok: status >= 200 && status < 300, status, headers: h, body: stream, blob: async () => new Blob(chunks ?? [body]) };
}

test('bridge fetch: no cookies, no referrer, progress, bounded, clear errors (CORS, HTTP, size, empty), abort passes through', async () => {
  let seen = null;
  const progress = [];
  const blob = await fetchMediaBlob('https://ex.org/a.mp4', {
    fetchImpl: async (url, init) => { seen = init; return fakeResponse({ headers: { 'content-length': '6', 'content-type': 'video/mp4' }, chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])] }); },
    onProgress: (r, t) => progress.push([r, t]),
  });
  assert.equal(blob.size, 6); assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(progress, [[3, 6], [6, 6]]);
  assert.equal(seen.credentials, 'omit'); assert.equal(seen.referrerPolicy, 'no-referrer');
  await assert.rejects(fetchMediaBlob('https://ex.org/a.mp4', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), e => e.code === 'SOURCE_NOT_READABLE' && /Téléchargez-le/.test(e.message));
  await assert.rejects(fetchMediaBlob('https://ex.org/a.mp4', { fetchImpl: async () => fakeResponse({ status: 404 }) }), e => e.code === 'SOURCE_HTTP_ERROR');
  await assert.rejects(fetchMediaBlob('https://ex.org/a.mp4', { fetchImpl: async () => fakeResponse({ headers: { 'content-length': String(BRIDGE_MAX_BYTES + 1) } }) }), e => e.code === 'FILE_TOO_LARGE');
  await assert.rejects(fetchMediaBlob('https://ex.org/a.mp4', { maxBytes: 4, fetchImpl: async () => fakeResponse({ chunks: [new Uint8Array(3), new Uint8Array(3)] }) }), e => e.code === 'FILE_TOO_LARGE', 'undeclared size still bounded while streaming');
  await assert.rejects(fetchMediaBlob('https://ex.org/a.mp4', { fetchImpl: async () => fakeResponse({ chunks: [] }) }), e => e.code === 'EMPTY_SOURCE');
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(fetchMediaBlob('https://ex.org/a.mp4', { fetchImpl: async () => { throw abort; } }), e => e === abort);
  assert.equal(bridgeFileName('https://ex.org/films/mon%20clip.webm?x=1', 'T'), 'mon clip.webm');
  assert.equal(bridgeFileName('https://ex.org/watch', 'Titre du lecteur'), 'Titre du lecteur');
  assert.equal(bridgeFileName('not a url', ''), 'média');
});

test('static: Media Reader offers the studio only for loaded video / audio / image; App wires it; F2 used', () => {
  const reader = fs.readFileSync('src/components/media/MediaReader.tsx', 'utf8');
  assert.match(reader, /descriptor\.kind === 'video' \|\| descriptor\.kind === 'audio' \|\| descriptor\.kind === 'image'/);
  assert.match(reader, /state\.phase === 'READY'/);
  assert.match(reader, /!descriptor\.blocked/);
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /onSendToMediaStudio=\{/);
  assert.match(app, /case 'media-studio':\s+setMediaStudioOpen\(true\)/);
  const modal = fs.readFileSync('src/components/modals/MediaStudioModal.tsx', 'utf8');
  assert.ok(modal.includes("useLongOperation('mediaStudioImport')") && modal.includes('OPERATION_POLICIES.mediaStudioExport') && modal.includes('<OperationProgress'), 'import + export on the F2 model');
  assert.doesNotMatch(modal, /dangerouslySetInnerHTML|eval\(/);
});
