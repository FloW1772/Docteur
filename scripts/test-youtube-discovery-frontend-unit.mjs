// Unit tests of the YouTube Smart Discovery V2 frontend logic (pure TypeScript, run through Node's type stripping).
// Usage: node --test scripts/test-youtube-discovery-frontend-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectYouTubeDiscoveryInput } from '../src/lib/youtube/discovery-input.ts';
import {
  applyDiscoveryEvent, createDiscoveryView, discoveryStatusText, failureView, formatDuration, isActive,
} from '../src/lib/youtube/discovery-view.ts';

const detect = detectYouTubeDiscoveryInput;

test('channel URLs map to the right mode, the tab is never rewritten', () => {
  const table = [
    ['https://www.youtube.com/@Ines-n9m', 'CHANNEL_ALL_MEDIA', null],
    ['https://youtube.com/@Ines-n9m', 'CHANNEL_ALL_MEDIA', null],
    ['https://www.youtube.com/@Ines-n9m/', 'CHANNEL_ALL_MEDIA', null],
    ['https://www.youtube.com/@Ines-n9m?si=x', 'CHANNEL_ALL_MEDIA', null],
    ['https://www.youtube.com/@Ines-n9m/featured', 'CHANNEL_ALL_MEDIA', null],
    ['https://www.youtube.com/@Ines-n9m/videos', 'CHANNEL_VIDEOS_ONLY', 'videos'],
    ['https://www.youtube.com/@Ines-n9m/shorts', 'CHANNEL_SHORTS_ONLY', 'shorts'],
    ['https://www.youtube.com/@Ines-n9m/streams', 'CHANNEL_STREAMS_ONLY', 'streams'],
    ['https://www.youtube.com/channel/UCkVv-e3hXZd_V2CTQSgsmSg/shorts', 'CHANNEL_SHORTS_ONLY', 'shorts'],
    ['https://www.youtube.com/c/Name/videos', 'CHANNEL_VIDEOS_ONLY', 'videos'],
    ['https://www.youtube.com/user/Name', 'CHANNEL_ALL_MEDIA', null],
  ];
  for (const [url, mode, tab] of table) {
    const r = detect(url);
    assert.ok(r, url);
    assert.equal(r.mode, mode, url);
    assert.equal(r.tab, tab, url);
    assert.equal(r.input, url, 'the URL is sent unchanged (server canonicalises)');
    assert.equal(r.context, undefined);
  }
});

test('single video, single Short, playlist, /live, unsupported tabs and foreign hosts are not channel discoveries', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PLabcdef', 'https://www.youtube.com/@Ines-n9m/live', 'https://www.youtube.com/@Ines-n9m/playlists',
    'https://www.youtube.com/@Ines-n9m/community', 'https://example.com/@Ines-n9m', 'https://www.youtube.com/', 'not a url', '',
  ]) assert.equal(detect(url), null, url);
});

test('a bare @handle is only a YouTube request behind an explicit workflow prefix', () => {
  assert.equal(detect('@Ines-n9m'), null);
  assert.equal(detect('/@Ines-n9m'), null);
  for (const prefixed of ['yt @Ines-n9m', 'youtube @Ines-n9m', 'chaine @Ines-n9m', 'chaîne @Ines-n9m', 'YT @Ines-n9m']) {
    const r = detect(prefixed);
    assert.ok(r, prefixed);
    assert.equal(r.input, '@Ines-n9m');
    assert.equal(r.context, 'youtube');
    assert.equal(r.mode, 'CHANNEL_ALL_MEDIA');
    assert.equal(r.handle, '@Ines-n9m');
  }
  assert.equal(detect('yt @Ines-n9m/shorts').mode, 'CHANNEL_SHORTS_ONLY');
  assert.equal(detect('yt /@Ines-n9m/videos').mode, 'CHANNEL_VIDEOS_ONLY');
  assert.equal(detect('chaine https://www.youtube.com/@Ines-n9m/streams').mode, 'CHANNEL_STREAMS_ONLY');
  assert.equal(detect('chaine https://www.youtube.com/@Ines-n9m/streams').context, undefined);
  assert.equal(detect('yt hello world'), null);
  assert.equal(detect('yt https://example.com/x'), null);
});

test('unicode handles survive', () => {
  assert.equal(detect('yt @テスト').handle, '@テスト');
  assert.equal(detect('https://www.youtube.com/@%E3%83%86%E3%82%B9%E3%83%88/shorts').handle, '@テスト');
});

// ─── view model ───────────────────────────────────────────────────────────────────────────────────────
const feed = (view, events) => events.reduce((v, e) => applyDiscoveryEvent(v, e, 5000), view);

test('root channel: per-type counts, unique total, phase labels in order, finalizing then done', () => {
  let v = createDiscoveryView({ input: '@x', mode: 'CHANNEL_ALL_MEDIA', handle: '@x' }, 0);
  assert.equal(v.status, 'analyzing');
  assert.equal(discoveryStatusText(v), 'Analyse de l’URL…');
  assert.equal(isActive(v), true);
  v = feed(v, [{ type: 'start', input: '@x', at: 0 }, { type: 'mode', mode: 'CHANNEL_ALL_MEDIA', kind: 'channel', handle: '@x', canonicalUrl: 'u', sources: ['videos', 'shorts', 'streams'] }]);
  assert.equal(discoveryStatusText(v), 'Chaîne détectée : @x');
  v = feed(v, [{ type: 'phase_start', tab: 'videos', index: 0, total: 3 }]);
  assert.equal(discoveryStatusText(v), 'Recherche vidéos…');
  v = feed(v, [{ type: 'progress', tab: 'videos', pages: 4, count: 120, total: 120, elapsedMs: 1 }]);
  assert.equal(v.phases[0].count, 120);
  assert.equal(v.phases[0].pages, 4);
  v = feed(v, [{ type: 'phase_done', tab: 'videos', count: 823, available: true, pages: 9, durationMs: 1, total: 823 }, { type: 'phase_start', tab: 'shorts', index: 1, total: 3 }]);
  assert.equal(discoveryStatusText(v), 'Recherche Shorts…');
  v = feed(v, [{ type: 'phase_done', tab: 'shorts', count: 2573, available: true, pages: 86, durationMs: 1, total: 3396 }, { type: 'phase_start', tab: 'streams', index: 2, total: 3 }]);
  assert.equal(discoveryStatusText(v), 'Recherche streams…');
  v = feed(v, [{ type: 'phase_done', tab: 'streams', count: 0, available: false, pages: 0, durationMs: 1, total: 3396 }]);
  assert.equal(v.status, 'finalizing');
  assert.equal(discoveryStatusText(v), 'Finalisation…');
  assert.deepEqual(v.phases.map(p => [p.tab, p.status, p.count]), [['videos', 'done', 823], ['shorts', 'done', 2573], ['streams', 'unavailable', 0]]);
  v = feed(v, [{ type: 'done', mode: 'CHANNEL_ALL_MEDIA', total: 3396, counts: {}, duplicates: 0, durationMs: 9, channel: { handle: '@x', url: 'u', title: 't', uploader: 'x', id: 'UC' } }]);
  assert.equal(v.status, 'done');
  assert.equal(discoveryStatusText(v), 'Terminé : 3396 éléments');
  assert.equal(isActive(v), false);
});

test('explicit tab: only that phase exists (no videos/streams rows or labels)', () => {
  for (const [mode, tab, label] of [['CHANNEL_SHORTS_ONLY', 'shorts', 'Recherche Shorts…'], ['CHANNEL_VIDEOS_ONLY', 'videos', 'Recherche vidéos…'], ['CHANNEL_STREAMS_ONLY', 'streams', 'Recherche streams…']]) {
    let v = createDiscoveryView({ input: 'u', mode, handle: '@x' }, 0);
    assert.deepEqual(v.phases.map(p => p.tab), [tab]);
    v = feed(v, [{ type: 'mode', mode, kind: 'channel', handle: '@x', canonicalUrl: 'u', sources: [tab] }, { type: 'phase_start', tab, index: 0, total: 1 }]);
    assert.equal(discoveryStatusText(v), label);
    v = feed(v, [{ type: 'phase_done', tab, count: 5, available: true, pages: 1, durationMs: 1, total: 5 }]);
    assert.equal(v.status, 'finalizing');
  }
});

test('terminal states: cancelled / timeout / error are distinct and inactive', () => {
  const base = createDiscoveryView({ input: 'u', mode: 'CHANNEL_ALL_MEDIA', handle: null }, 0);
  const cancelled = feed(base, [{ type: 'cancelled', total: 3 }]);
  assert.equal(discoveryStatusText(cancelled), 'Annulé');
  const timeout = feed(base, [{ type: 'error', name: 'TimeoutError', code: 'DISCOVERY_STALLED', message: 'yt-dlp ne répond plus' }]);
  assert.equal(timeout.status, 'timeout');
  assert.match(discoveryStatusText(timeout), /^Timeout : yt-dlp ne répond plus/);
  const error = feed(base, [{ type: 'error', name: 'Error', code: 'YTDLP_ERROR', message: 'Vidéo supprimée ou indisponible' }]);
  assert.equal(error.status, 'error');
  assert.match(discoveryStatusText(error), /^Erreur yt-dlp : Vidéo supprimée/);
  for (const v of [cancelled, timeout, error]) assert.equal(isActive(v), false);
  assert.equal(failureView(base, Object.assign(new Error('x'), { name: 'AbortError' })).status, 'cancelled');
  assert.equal(failureView(base, Object.assign(new Error('x'), { name: 'TimeoutError' })).status, 'timeout');
  assert.equal(failureView(base, new Error('Failed to fetch')).status, 'error');
});

test('duration formatting', () => {
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(59_999), '59 s');
  assert.equal(formatDuration(84_000), '1 min 24 s');
});

test('applying 50 000 events stays cheap (batched flush design relies on a pure fold)', () => {
  let v = createDiscoveryView({ input: 'u', mode: 'CHANNEL_SHORTS_ONLY', handle: null }, 0);
  v = feed(v, [{ type: 'phase_start', tab: 'shorts', index: 0, total: 1 }]);
  const t0 = performance.now();
  for (let i = 1; i <= 50_000; i++) v = applyDiscoveryEvent(v, { type: 'progress', tab: 'shorts', pages: Math.ceil(i / 30), count: i, total: i, elapsedMs: i });
  assert.equal(v.total, 50_000);
  assert.ok(performance.now() - t0 < 1500);
});
