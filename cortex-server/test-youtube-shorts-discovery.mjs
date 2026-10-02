import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  classifyYouTubeUrl,
  getPlaylistInfo,
  normalizeChannelVideosUrl,
  normalizeDiscoveryOptions,
  parsePlaylistData,
} from './src/lib/ytdlp.js';

const SHORTS_URL = 'https://www.youtube.com/@example/shorts';
const VIDEOS_URL = 'https://www.youtube.com/@example/videos';

function entries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `video${String(index).padStart(5, '0')}`,
    title: `Video ${index + 1}`,
    playlist_title: 'Example collection',
    playlist_uploader: 'Example channel',
    playlist_id: 'example-id',
    playlist_count: count,
  }));
}

function fakeSpawn(items, { calls = [], intervalMs = 0, stall = false } = {}) {
  return (_bin, args) => {
    calls.push(args);
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    let timer = null;
    proc.kill = () => {
      if (proc.killed) return true;
      proc.killed = true;
      if (timer) clearTimeout(timer);
      queueMicrotask(() => proc.emit('close', 1));
      return true;
    };

    if (!stall && intervalMs === 0) {
      queueMicrotask(() => {
        if (proc.killed) return;
        proc.stdout.end(items.map(item => JSON.stringify(item)).join('\n'));
        proc.emit('close', 0);
      });
    } else if (!stall) {
      let index = 0;
      const emitNext = () => {
        if (proc.killed) return;
        if (index >= items.length) {
          proc.stdout.end();
          proc.emit('close', 0);
          return;
        }
        proc.stdout.write(`${JSON.stringify(items[index++])}\n`);
        timer = setTimeout(emitNext, intervalMs);
      };
      timer = setTimeout(emitNext, intervalMs);
    }
    return proc;
  };
}

test('preserves @handle, /channel and legacy /c Shorts tabs', () => {
  for (const url of [
    'https://www.youtube.com/@example/shorts',
    'https://www.youtube.com/channel/UC123/shorts',
    'https://www.youtube.com/c/example/shorts',
  ]) {
    assert.equal(classifyYouTubeUrl(url).kind, 'channel_shorts');
    assert.match(normalizeChannelVideosUrl(url), /\/shorts$/);
  }
});

test('preserves /videos behavior for channel roots and existing tabs', () => {
  assert.equal(normalizeChannelVideosUrl('https://www.youtube.com/@example'), VIDEOS_URL);
  assert.equal(normalizeChannelVideosUrl('https://www.youtube.com/@example/featured'), VIDEOS_URL);
});

test('validates only 25, 50, 100 or explicit all mode', () => {
  for (const limit of [25, 50, 100]) {
    assert.deepEqual(normalizeDiscoveryOptions({ mode: 'limited', limit }), { mode: 'limited', limit });
  }
  assert.deepEqual(normalizeDiscoveryOptions({ mode: 'all' }), { mode: 'all', limit: null });
  for (const limit of [-1, 0, NaN, '50', 101, 250, 10_000]) {
    assert.throws(() => normalizeDiscoveryOptions({ mode: 'limited', limit }), TypeError);
  }
  assert.throws(() => normalizeDiscoveryOptions({ mode: 'all', limit: 100 }), TypeError);
  assert.throws(() => normalizeDiscoveryOptions({ mode: 'anything', limit: 25 }), TypeError);
});

test('limited mode returns exactly 25 Shorts', () => {
  const result = parsePlaylistData({ entries: entries(250), playlist_count: 250 }, { sourceUrl: SHORTS_URL, limit: 25 });
  assert.equal(result.video_count, 25);
  assert.equal(result.limit_reached, true);
});

test('limited mode returns exactly 50 Shorts', () => {
  const result = parsePlaylistData({ entries: entries(250), playlist_count: 250 }, { sourceUrl: SHORTS_URL, limit: 50 });
  assert.equal(result.video_count, 50);
});

test('limited mode returns exactly 100 Shorts', () => {
  const result = parsePlaylistData({ entries: entries(250), playlist_count: 250 }, { sourceUrl: SHORTS_URL, limit: 100 });
  assert.equal(result.video_count, 100);
});

test('all mode returns 101 Shorts without an artificial maximum', () => {
  const result = parsePlaylistData({ entries: entries(101) }, { sourceUrl: SHORTS_URL, mode: 'all' });
  assert.equal(result.video_count, 101);
  assert.equal(result.limit, null);
  assert.equal(result.limit_reached, false);
});

test('all mode returns all 250 Shorts', () => {
  const result = parsePlaylistData({ entries: entries(250) }, { sourceUrl: SHORTS_URL, mode: 'all' });
  assert.equal(result.video_count, 250);
  assert.equal(new Set(result.videos.map(video => video.id)).size, 250);
});

test('all mode never passes --playlist-end to yt-dlp', async () => {
  const calls = [];
  const result = await getPlaylistInfo(SHORTS_URL, {
    mode: 'all',
    spawnImpl: fakeSpawn(entries(250), { calls }),
  });
  assert.equal(result.video_count, 250);
  assert.equal(calls[0].includes('--playlist-end'), false);
});

test('limited modes pass their exact --playlist-end value', async () => {
  for (const limit of [25, 50, 100]) {
    const calls = [];
    const result = await getPlaylistInfo(SHORTS_URL, {
      mode: 'limited', limit,
      spawnImpl: fakeSpawn(entries(250), { calls }),
    });
    assert.equal(result.video_count, limit);
    assert.deepEqual(calls[0].slice(-2), ['--playlist-end', String(limit)]);
  }
});

test('deduplicates duplicate IDs in all mode', () => {
  const batch = entries(250);
  const result = parsePlaylistData({ entries: [...batch, batch[2], batch[2], batch[249]] }, {
    sourceUrl: SHORTS_URL,
    mode: 'all',
  });
  assert.equal(result.video_count, 250);
});

test('cancels an all-mode process without leaving it running', async () => {
  const controller = new AbortController();
  const pending = getPlaylistInfo(SHORTS_URL, {
    mode: 'all', signal: controller.signal,
    spawnImpl: fakeSpawn(entries(250), { intervalMs: 10 }),
  });
  controller.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
});

test('slow progress may exceed the inactivity window total duration while IDs keep arriving', async () => {
  const progress = [];
  const result = await getPlaylistInfo(SHORTS_URL, {
    mode: 'all', inactivityTimeoutMs: 30,
    onProgress: ({ count }) => progress.push(count),
    spawnImpl: fakeSpawn(entries(12), { intervalMs: 5 }),
  });
  assert.equal(result.video_count, 12);
  assert.deepEqual(progress, Array.from({ length: 12 }, (_, index) => index + 1));
});

test('stalled collection ends on inactivity timeout', async () => {
  await assert.rejects(
    getPlaylistInfo(SHORTS_URL, {
      mode: 'all', inactivityTimeoutMs: 5,
      spawnImpl: fakeSpawn([], { stall: true }),
    }),
    error => error?.name === 'TimeoutError',
  );
});

test('natural yt-dlp completion ends all mode normally', async () => {
  const result = await getPlaylistInfo(SHORTS_URL, {
    mode: 'all',
    spawnImpl: fakeSpawn(entries(7)),
  });
  assert.equal(result.video_count, 7);
  assert.equal(result.limit_reached, false);
});

test('/videos supports 25 and 100 limited modes', () => {
  for (const limit of [25, 100]) {
    const result = parsePlaylistData({ entries: entries(250) }, { sourceUrl: VIDEOS_URL, limit });
    assert.equal(result.video_count, limit);
    assert.ok(result.videos.every(video => video.url.includes('/watch?v=')));
  }
});

test('/videos all mode returns every entry without --playlist-end', async () => {
  const calls = [];
  const result = await getPlaylistInfo(VIDEOS_URL, {
    mode: 'all',
    spawnImpl: fakeSpawn(entries(250), { calls }),
  });
  assert.equal(result.video_count, 250);
  assert.equal(calls[0].includes('--playlist-end'), false);
  assert.ok(result.videos.every(video => video.url.includes('/watch?v=')));
});

test('single Short URL still produces exactly one canonical video', async () => {
  const result = await getPlaylistInfo('https://www.youtube.com/shorts/ABCDEFGHIJK?feature=share', { mode: 'all' });
  assert.equal(result.video_count, 1);
  assert.deepEqual(result.videos, [{ id: 'ABCDEFGHIJK', url: 'https://www.youtube.com/shorts/ABCDEFGHIJK' }]);
});

test('zero-item collection completes naturally', async () => {
  const result = await getPlaylistInfo(SHORTS_URL, {
    mode: 'all',
    spawnImpl: fakeSpawn([]),
  });
  assert.equal(result.video_count, 0);
});

test('limit_reached semantics: unique-count based, same for /shorts and /videos', async () => {
  for (const url of [SHORTS_URL, VIDEOS_URL]) {
    for (const [limit, available, expected] of [[25, 10, false], [25, 25, true], [50, 50, true], [100, 100, true], [100, 99, false]]) {
      const calls = [];
      const r = await getPlaylistInfo(url, { limit, spawnImpl: fakeSpawn(entries(available), { calls }) });
      assert.equal(r.limit_reached, expected, `${url} limit ${limit} available ${available}`);
      assert.equal(r.requested_limit, limit);
      assert.equal(r.returned_count, Math.min(limit, available));
      assert.equal(calls[0].includes('--playlist-end'), true);
      if (available < limit) assert.equal(r.has_more, false);
    }
  }
});

test('limit_reached: has_more is never invented when count == limit', async () => {
  const r = await getPlaylistInfo(SHORTS_URL, { limit: 100, spawnImpl: fakeSpawn(entries(100)) });
  assert.equal(r.limit_reached, true);
  assert.equal(r.has_more, null);
  const items = entries(100).map(e => ({ ...e, playlist_count: 250 }));
  const r2 = await getPlaylistInfo(SHORTS_URL, { limit: 100, spawnImpl: fakeSpawn(items) });
  assert.equal(r2.has_more, true);
});

test('limit_reached: ALL mode is always false with requested_limit null', async () => {
  const r = await getPlaylistInfo(SHORTS_URL, { mode: 'all', spawnImpl: fakeSpawn(entries(201)) });
  assert.equal(r.video_count, 201);
  assert.equal(r.limit_reached, false);
  assert.equal(r.requested_limit, null);
  assert.equal(r.has_more, false);
});

test('limit_reached: uses unique IDs, not raw NDJSON lines', async () => {
  const dup = (n, uniq) => { const base = entries(uniq); return Array.from({ length: n }, (_, i) => ({ ...base[i % uniq], playlist_count: undefined })); };
  const below = await getPlaylistInfo(SHORTS_URL, { limit: 100, spawnImpl: fakeSpawn(dup(105, 98)) });
  assert.equal(below.video_count, 98);
  assert.equal(below.limit_reached, false);
  const reach = await getPlaylistInfo(SHORTS_URL, { limit: 100, spawnImpl: fakeSpawn(dup(120, 100)) });
  assert.equal(reach.video_count, 100);
  assert.equal(reach.limit_reached, true);
});

test('cancelled or failed limited collection yields no result (never limit_reached)', async () => {
  const controller = new AbortController();
  const pending = getPlaylistInfo(SHORTS_URL, { limit: 100, signal: controller.signal, spawnImpl: fakeSpawn(entries(250), { intervalMs: 10 }) });
  controller.abort();
  await assert.rejects(pending, e => e?.name === 'AbortError');
  await assert.rejects(getPlaylistInfo(SHORTS_URL, { limit: 100, inactivityTimeoutMs: 5, spawnImpl: fakeSpawn([], { stall: true }) }), e => e?.name === 'TimeoutError');
});
