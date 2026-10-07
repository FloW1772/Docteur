// YouTube Multi-Channel Scraper V1 — input parsing / normalisation / dedup, bounded FIFO queue, failure isolation,
// per-channel cancellation and retry, grouped results, HTTP routes, and reuse of the EXISTING discovery path
// (discoverYouTube → runYtDlpSource → prepareYtDlp → killProcessTree). No real network, no real yt-dlp process.
// Run: node --test test-youtube-multi-channel.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Hono } from 'hono';
import {
  JOB_STATUS as S, DEFAULT_CHANNEL_CONCURRENCY, MAX_CHANNEL_CONCURRENCY, MAX_CHANNELS_PER_BATCH,
  clampConcurrency, createChannelDiscoveryQueue, normalizeChannelInput, parseChannelLines,
} from './src/lib/youtube-channel-queue.js';
import { discoverYouTube } from './src/lib/youtube-discovery.js';
import { createCaptureRoute } from './src/routes/capture.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UC = 'UCkVv-e3hXZd_V2CTQSgsmSg';
const waitFor = async (predicate, label, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
};

// ─── controllable fake discover: each call is a deferred the test resolves / rejects; abort is honoured ───────────────
function fakeDiscover() {
  const calls = [];
  const discover = (input, { signal, onEvent }) => new Promise((resolve) => {
    const call = { input, signal, onEvent, aborted: false, settled: false };
    call.done = (items = [], channel = {}) => { if (call.settled) return; call.settled = true; resolve({ status: 'done', mode: 'CHANNEL_ALL_MEDIA', items, counts: {}, duplicates: 0, durationMs: 1, channel: { handle: null, url: input, title: '', uploader: '', id: '', ...channel } }); };
    call.fail = (message = 'boom', code = 'YTDLP_ERROR') => { if (call.settled) return; call.settled = true; resolve({ status: 'error', code, message, items: [] }); };
    call.crash = () => { if (call.settled) return; call.settled = true; resolve(Promise.reject(new Error('unexpected crash'))); };
    signal.addEventListener('abort', () => {
      call.aborted = true;
      // the real path resolves 'cancelled' only once the process tree is gone; tests release it explicitly
      call.releaseAbort = () => { if (call.settled) return; call.settled = true; resolve({ status: 'cancelled', items: [] }); };
    }, { once: true });
    onEvent({ type: 'start' });
    onEvent({ type: 'mode', mode: 'CHANNEL_ALL_MEDIA', sources: ['videos', 'shorts', 'streams'], handle: null });
    calls.push(call);
  });
  return { calls, discover };
}
const items = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`.padEnd(11, 'x'), title: `${prefix} ${i}`, url: `https://www.youtube.com/watch?v=${prefix}${i}` }));
const urls = (...handles) => handles.map(h => `https://www.youtube.com/@${h}`).join('\n');
const statuses = snap => snap.jobs.map(j => j.status);

// ─── 1. parsing, normalisation, validation ───────────────────────────────────────────────────────────────────────────
test('parseChannelLines: one URL per line, blank lines and surrounding spaces ignored, array form accepted', () => {
  assert.deepEqual(parseChannelLines('  https://www.youtube.com/@a  \r\n\n\t\nhttps://www.youtube.com/@b\n'), ['https://www.youtube.com/@a', 'https://www.youtube.com/@b']);
  assert.deepEqual(parseChannelLines(['https://www.youtube.com/@a', '', 42, ' x ']), ['https://www.youtube.com/@a', 'x']);
  assert.deepEqual(parseChannelLines(''), []);
  assert.deepEqual(parseChannelLines(undefined), []);
});

test('normalizeChannelInput: legitimate forms normalise to the canonical channel URL', () => {
  const table = [
    ['https://www.youtube.com/@Handle', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
    ['https://youtube.com/@Handle', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
    ['youtube.com/@Handle', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
    ['www.youtube.com/@Handle', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
    ['m.youtube.com/@Handle/', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
    ['https://www.youtube.com/@Handle/', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
    [`https://www.youtube.com/channel/${UC}`, `https://www.youtube.com/channel/${UC}`, 'CHANNEL_ALL_MEDIA'],
    [`https://www.youtube.com/channel/${UC}/shorts`, `https://www.youtube.com/channel/${UC}/shorts`, 'CHANNEL_SHORTS_ONLY'],
    ['https://www.youtube.com/@Handle/videos', 'https://www.youtube.com/@Handle/videos', 'CHANNEL_VIDEOS_ONLY'],
    ['yt @Handle', 'https://www.youtube.com/@Handle', 'CHANNEL_ALL_MEDIA'],
  ];
  for (const [input, url, mode] of table) {
    const r = normalizeChannelInput(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.normalizedUrl, url, input);
    assert.equal(r.mode, mode, input);
  }
  assert.equal(normalizeChannelInput(`https://www.youtube.com/channel/${UC}`).channelIdHint, UC);
  assert.equal(normalizeChannelInput('https://www.youtube.com/@Handle').channelIdHint, null);
});

test('normalizeChannelInput: an invalid line is never turned into a valid one, each gets a precise reason', () => {
  const table = [
    ['not a url', 'invalid_input'],
    ['htps://youtube.com/@x', 'invalid_input'],
    ['https://www.youtube.com/@bad handle', 'invalid_input'],
    ['https://evil.example/@x', 'not_youtube'],
    ['youtube.com.evil.example/@x', 'invalid_input'],
    ['@Handle', 'bare_handle_not_allowed'],
    ['https://www.youtube.com/@', 'invalid_handle'],
    ['https://www.youtube.com/', 'unsupported_path'],
    ['https://www.youtube.com/channel/not-an-id', 'invalid_channel'],
    ['https://www.youtube.com/@Handle/community', 'unsupported_tab'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'not_a_channel'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'not_a_channel'],
    ['https://www.youtube.com/playlist?list=PLabcdef', 'not_a_channel'],
    ['https://www.youtube.com/@Handle/live', 'not_a_channel'],
    ['https://www.youtube.com/@a;calc.exe', 'invalid_handle'],
    ['https://www.youtube.com/@$(whoami)', 'invalid_handle'],
  ];
  for (const [input, reason] of table) {
    const r = normalizeChannelInput(input);
    assert.equal(r.ok, false, input);
    assert.equal(r.reason, reason, input);
    assert.ok(r.message.length > 3, input);
  }
});

test('clampConcurrency: default 2, bounded 1..4, garbage falls back to the default', () => {
  assert.equal(DEFAULT_CHANNEL_CONCURRENCY, 2);
  assert.equal(MAX_CHANNEL_CONCURRENCY, 4);
  assert.equal(clampConcurrency(undefined), 2);
  assert.equal(clampConcurrency('3'), 3);
  assert.equal(clampConcurrency(99), 4);
  assert.equal(clampConcurrency(0), 2);
  assert.equal(clampConcurrency('x'), 2);
  assert.equal(createChannelDiscoveryQueue({ concurrency: 50, discover: fakeDiscover().discover }).concurrency, 4);
});

// ─── 2. batch creation ──────────────────────────────────────────────────────────────────────────────────────────────
test('one valid URL: single job, runs, completes, grouped result available', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover });
  const snap = q.createBatch('https://www.youtube.com/@solo');
  assert.equal(snap.jobs.length, 1);
  assert.deepEqual(statuses(snap), [S.RUNNING]);
  assert.equal(calls[0].input, 'https://www.youtube.com/@solo', 'the request handed to discoverYouTube is the URL itself');
  calls[0].done(items('s', 3), { uploader: 'Solo', id: 'UCsolo' });
  await waitFor(() => q.getBatch(snap.batchId).jobs[0].status === S.COMPLETED, 'completion');
  const done = q.getBatch(snap.batchId);
  assert.equal(done.summary.completed, 1);
  assert.equal(done.summary.active, false);
  assert.equal(done.jobs[0].channelName, 'Solo');
  assert.equal(done.jobs[0].itemsFound, 3);
  const result = q.getJobResult(snap.batchId, snap.jobs[0].id);
  assert.equal(result.items.length, 3);
  assert.equal(result.channel.uploader, 'Solo');
});

test('empty input and oversize paste are refused explicitly', () => {
  const q = createChannelDiscoveryQueue({ discover: fakeDiscover().discover });
  assert.throws(() => q.createBatch('  \n \n'), e => e.code === 'EMPTY_INPUT');
  assert.throws(() => q.createBatch(Array.from({ length: MAX_CHANNELS_PER_BATCH + 1 }, (_, i) => `https://www.youtube.com/@c${i}`)), e => e.code === 'TOO_MANY_INPUTS');
});

test('valid and invalid lines mixed: only the invalid line FAILS (INVALID_INPUT, not retryable), the others are processed', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 3 });
  const snap = q.createBatch('https://www.youtube.com/@a\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://www.youtube.com/@c');
  assert.deepEqual(statuses(snap), [S.RUNNING, S.FAILED, S.RUNNING]);
  assert.equal(snap.jobs[1].error.code, 'INVALID_INPUT');
  assert.equal(snap.jobs[1].error.reason, 'not_a_channel');
  assert.equal(snap.jobs[1].retryable, false);
  assert.deepEqual(calls.map(c => c.input), ['https://www.youtube.com/@a', 'https://www.youtube.com/@c']);
  assert.equal(q.retryJob(snap.batchId, snap.jobs[1].id).error.code, 'JOB_NOT_RETRYABLE');
  calls.forEach(c => c.done(items('x', 1)));
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'batch end');
  assert.deepEqual(statuses(q.getBatch(snap.batchId)), [S.COMPLETED, S.FAILED, S.COMPLETED]);
});

test('deduplication by normalised URL: same channel written differently is discovered once', () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 4 });
  const snap = q.createBatch([
    'https://www.youtube.com/@Chaine', 'youtube.com/@chaine/', 'https://m.youtube.com/@CHAINE', 'https://www.youtube.com/@Chaine/videos',
    `https://www.youtube.com/channel/${UC}`, `https://youtube.com/channel/${UC}/`,
  ].join('\n'));
  assert.deepEqual(statuses(snap), [S.RUNNING, S.DUPLICATE, S.DUPLICATE, S.RUNNING, S.RUNNING, S.DUPLICATE]);
  assert.equal(snap.jobs[1].duplicateOf, snap.jobs[0].id);
  assert.equal(snap.jobs[5].duplicateOf, snap.jobs[4].id);
  assert.match(snap.jobs[1].message, /ligne 1/);
  assert.equal(calls.length, 3, '/videos is a different request (one tab) — not merged into the root URL');
  assert.equal(snap.summary.duplicate, 3);
});

test('deduplication by channelId (no extra network call): a /channel/UC… line equal to an already resolved @handle is skipped', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(`https://www.youtube.com/@named\nhttps://www.youtube.com/@other\nhttps://www.youtube.com/channel/${UC}`);
  assert.deepEqual(statuses(snap), [S.RUNNING, S.QUEUED, S.QUEUED]);
  calls[0].done(items('n', 2), { id: UC, uploader: 'Named' });   // @named resolves to UC…
  await waitFor(() => calls.length === 2, 'second start');
  let now = q.getBatch(snap.batchId);
  assert.equal(now.jobs[2].status, S.DUPLICATE, 'marked as soon as the channel id is known');
  assert.equal(now.jobs[2].duplicateOf, snap.jobs[0].id);
  calls[1].done(items('o', 1), { id: 'UCother' });
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  now = q.getBatch(snap.batchId);
  assert.equal(calls.length, 2, 'the UC… line never reached yt-dlp');
  assert.deepEqual(statuses(now), [S.COMPLETED, S.COMPLETED, S.DUPLICATE]);
});

// ─── 3. queue: FIFO, concurrency, isolation ─────────────────────────────────────────────────────────────────────────
test('FIFO + concurrency limit: never more than N discoveries at once, started in input order', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 2 });
  const snap = q.createBatch(urls('c1', 'c2', 'c3', 'c4', 'c5'));
  let peak = 0;
  const track = () => { peak = Math.max(peak, q.runningCount()); };
  track();
  assert.deepEqual(statuses(snap), [S.RUNNING, S.RUNNING, S.QUEUED, S.QUEUED, S.QUEUED]);
  assert.equal(q.runningCount(), 2);
  for (let i = 0; i < 5; i++) {
    await waitFor(() => calls.length > i, `start ${i}`);
    track();
    calls[i].done(items(`c${i}`, 1));
    await sleep(5);
    track();
  }
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  assert.equal(peak, 2);
  assert.deepEqual(calls.map(c => c.input), ['c1', 'c2', 'c3', 'c4', 'c5'].map(h => `https://www.youtube.com/@${h}`));
});

test('the limit is global: two batches share the same slots', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 2 });
  const a = q.createBatch(urls('a1', 'a2'));
  const b = q.createBatch(urls('b1'));
  assert.equal(q.runningCount(), 2);
  assert.deepEqual(statuses(q.getBatch(b.batchId)), [S.QUEUED]);
  calls[0].done();
  await waitFor(() => q.getBatch(b.batchId).jobs[0].status === S.RUNNING, 'b1 starts when a slot frees');
  calls[1].done(); calls[2].done();
  await waitFor(() => !q.getBatch(a.batchId).summary.active && !q.getBatch(b.batchId).summary.active, 'end');
});

test('failure isolation: A ok, B fails (yt-dlp error), C ok — the queue continues and the slot is released after the error', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(urls('A', 'B', 'C'));
  calls[0].done(items('a', 2));
  await waitFor(() => calls.length === 2, 'B starts');
  calls[1].fail('Chaîne introuvable ou privée', 'YTDLP_ERROR');
  await waitFor(() => calls.length === 3, 'C starts after B failed (slot released)');
  calls[2].done(items('c', 3));
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  const end = q.getBatch(snap.batchId);
  assert.deepEqual(statuses(end), [S.COMPLETED, S.FAILED, S.COMPLETED]);
  assert.equal(end.jobs[1].error.message, 'Chaîne introuvable ou privée');
  assert.equal(end.jobs[1].retryable, true);
  assert.deepEqual({ c: end.summary.completed, f: end.summary.failed, items: end.summary.items }, { c: 2, f: 1, items: 5 });
});

test('a crashing discovery (rejected promise) and a timeout are FAILED for that channel only', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(urls('crash', 'slow', 'ok'));
  calls[0].crash();
  await waitFor(() => calls.length === 2, 'next after crash');
  calls[1].fail('yt-dlp ne répond plus (aucune activité depuis 90 s)', 'DISCOVERY_STALLED');
  await waitFor(() => calls.length === 3, 'next after timeout');
  calls[2].done();
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  const end = q.getBatch(snap.batchId);
  assert.deepEqual(statuses(end), [S.FAILED, S.FAILED, S.COMPLETED]);
  assert.equal(end.jobs[0].error.message, 'unexpected crash');
  assert.equal(end.jobs[1].error.code, 'DISCOVERY_STALLED');
});

test('per-channel progress comes from the discovery events (phases, pages, items found)', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover });
  const snap = q.createBatch(urls('p'));
  const c = calls[0];
  c.onEvent({ type: 'phase_start', tab: 'videos', index: 0, total: 3 });
  c.onEvent({ type: 'progress', tab: 'videos', pages: 4, count: 120, total: 120 });
  let job = q.getBatch(snap.batchId).jobs[0];
  assert.equal(job.currentTab, 'videos');
  assert.equal(job.pages, 4);
  assert.equal(job.itemsFound, 120);
  assert.deepEqual(job.phases.map(p => p.status), ['running', 'pending', 'pending']);
  c.onEvent({ type: 'phase_done', tab: 'videos', count: 130, available: true, pages: 5, total: 130 });
  c.onEvent({ type: 'phase_done', tab: 'shorts', count: 0, available: false, pages: 0, total: 130 });
  job = q.getBatch(snap.batchId).jobs[0];
  assert.deepEqual(job.phases.map(p => p.status), ['done', 'unavailable', 'pending']);
  assert.equal(job.itemsFound, 130);
  c.done(items('p', 130));
});

// ─── 4. cancellation and retry ──────────────────────────────────────────────────────────────────────────────────────
test('cancel a QUEUED channel: never started, others continue', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(urls('A', 'B', 'C'));
  const cancelled = q.cancelJob(snap.batchId, snap.jobs[1].id);
  assert.deepEqual(statuses(cancelled), [S.RUNNING, S.CANCELLED, S.QUEUED]);
  calls[0].done();
  await waitFor(() => calls.length === 2, 'C starts');
  assert.equal(calls[1].input, 'https://www.youtube.com/@C', 'B was skipped');
  calls[1].done();
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  assert.deepEqual(statuses(q.getBatch(snap.batchId)), [S.COMPLETED, S.CANCELLED, S.COMPLETED]);
});

test('cancel a RUNNING channel: abort reaches the discovery, the slot is released only once it has settled, the rest continue', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(urls('A', 'B'));
  const after = q.cancelJob(snap.batchId, snap.jobs[0].id);
  assert.equal(after.jobs[0].status, S.CANCELLED, 'shown cancelled immediately');
  assert.equal(calls[0].signal.aborted, true, 'the AbortSignal of the running discovery fired (→ process-tree kill)');
  assert.equal(q.runningCount(), 1, 'slot still held while the process tree is being killed');
  assert.equal(after.jobs[1].status, S.QUEUED);
  calls[0].releaseAbort();
  await waitFor(() => calls.length === 2, 'B starts once A has really stopped');
  assert.equal(q.getBatch(snap.batchId).jobs[0].status, S.CANCELLED, 'a late "cancelled"/"done" never overrides the user decision');
  calls[1].done();
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  assert.equal(q.runningCount(), 0);
});

test('a result arriving after the user cancelled does not resurrect the job', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover });
  const snap = q.createBatch(urls('late'));
  q.cancelJob(snap.batchId, snap.jobs[0].id);
  calls[0].done(items('l', 5)); // yt-dlp finished just as the kill was issued
  await waitFor(() => q.runningCount() === 0, 'settled');
  const job = q.getBatch(snap.batchId).jobs[0];
  assert.equal(job.status, S.CANCELLED);
  assert.equal(q.getJobResult(snap.batchId, job.id).error.code, 'JOB_NOT_COMPLETED');
});

test('cancel after completion is refused (409) and changes nothing', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover });
  const snap = q.createBatch(urls('done'));
  calls[0].done(items('d', 1));
  await waitFor(() => q.getBatch(snap.batchId).jobs[0].status === S.COMPLETED, 'done');
  const r = q.cancelJob(snap.batchId, snap.jobs[0].id);
  assert.equal(r.error.code, 'JOB_ALREADY_FINISHED');
  assert.equal(r.error.status, 409);
  assert.equal(q.getBatch(snap.batchId).jobs[0].status, S.COMPLETED);
});

test('cancel all: running + queued are cancelled, completed and failed stay as they are', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(`${urls('A', 'B', 'C', 'D')}\nnot a url`);
  calls[0].done();
  await waitFor(() => calls.length === 2, 'B running');
  const after = q.cancelBatch(snap.batchId);
  assert.deepEqual(statuses(after), [S.COMPLETED, S.CANCELLED, S.CANCELLED, S.CANCELLED, S.FAILED]);
  assert.equal(calls[1].signal.aborted, true);
  calls[1].releaseAbort();
  await waitFor(() => q.runningCount() === 0, 'slot freed');
  assert.equal(calls.length, 2, 'nothing else started');
  assert.equal(after.summary.active, false);
});

test('retry: only a FAILED/CANCELLED channel, goes back to the end of the FIFO; completed channels are never redone', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const snap = q.createBatch(urls('A', 'B'));
  calls[0].fail('réseau');
  await waitFor(() => calls.length === 2, 'B');
  calls[1].done(items('b', 2));
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  assert.equal(q.retryJob(snap.batchId, snap.jobs[1].id).error.code, 'JOB_NOT_RETRYABLE', 'completed: not redone');
  const retried = q.retryJob(snap.batchId, snap.jobs[0].id);
  assert.equal(retried.jobs[0].status, S.RUNNING);
  assert.equal(retried.jobs[0].error, null, 'previous error cleared');
  assert.equal(q.retryJob(snap.batchId, snap.jobs[0].id).error.code, 'JOB_NOT_RETRYABLE', 'no double launch while running');
  calls[2].done(items('a', 4));
  await waitFor(() => q.getBatch(snap.batchId).jobs[0].status === S.COMPLETED, 'retried ok');
  const end = q.getBatch(snap.batchId);
  assert.equal(end.jobs[0].attempts, 2);
  assert.equal(end.jobs[1].attempts, 1);
  assert.equal(calls.length, 3);
});

test('retry right after cancelling a running channel: the old run cannot overwrite the new one', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 2 });
  const snap = q.createBatch(urls('R'));
  q.cancelJob(snap.batchId, snap.jobs[0].id);
  q.retryJob(snap.batchId, snap.jobs[0].id);
  assert.equal(calls.length, 2, 'new run started in the free slot');
  calls[0].done(items('old', 9)); // old run settles late
  await sleep(10);
  assert.equal(q.getBatch(snap.batchId).jobs[0].status, S.RUNNING);
  calls[1].done(items('new', 2));
  await waitFor(() => q.getBatch(snap.batchId).jobs[0].status === S.COMPLETED, 'new run done');
  assert.equal(q.getJobResult(snap.batchId, snap.jobs[0].id).items.length, 2);
});

test('grouped results: each completed channel returns ITS items only; unknown ids are 404', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 3 });
  const snap = q.createBatch(urls('A', 'B', 'C'));
  calls[0].done(items('a', 2), { uploader: 'Chaîne A' });
  calls[1].fail('erreur B');
  calls[2].done(items('c', 3), { uploader: 'Chaîne C' });
  await waitFor(() => !q.getBatch(snap.batchId).summary.active, 'end');
  const a = q.getJobResult(snap.batchId, snap.jobs[0].id);
  const c = q.getJobResult(snap.batchId, snap.jobs[2].id);
  assert.deepEqual(a.items.map(i => i.title), ['a 0', 'a 1']);
  assert.deepEqual(c.items.map(i => i.title), ['c 0', 'c 1', 'c 2']);
  assert.equal(a.job.channelName, 'Chaîne A');
  assert.equal(q.getJobResult(snap.batchId, snap.jobs[1].id).error.code, 'JOB_NOT_COMPLETED');
  assert.equal(q.getJobResult(snap.batchId, 'nope').error.status, 404);
  assert.equal(q.getBatch('nope').error.code, 'BATCH_NOT_FOUND');
  assert.equal(q.getJobResult('nope', snap.jobs[0].id).error.status, 404);
});

test('retention: finished batches are forgotten after the retention window, active ones never', async () => {
  let t = 1_000;
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, now: () => t, retentionMs: 100, concurrency: 1 });
  const old = q.createBatch(urls('old'));
  calls[0].done();
  await waitFor(() => !q.getBatch(old.batchId).summary.active, 'old done');
  const active = q.createBatch(urls('busy'));
  t += 1_000;
  q.createBatch(urls('new')); // pruning happens on creation
  assert.equal(q.getBatch(old.batchId).error.code, 'BATCH_NOT_FOUND');
  assert.equal(q.getBatch(active.batchId).summary.active, true);
  const closing = q.close();
  calls.forEach(c => c.releaseAbort?.());
  await closing;
});

test('close(): every running discovery is aborted and awaited, nothing left running, new batches refused', async () => {
  const { calls, discover } = fakeDiscover();
  const q = createChannelDiscoveryQueue({ discover, concurrency: 2 });
  const snap = q.createBatch(urls('A', 'B', 'C'));
  const closing = q.close();
  assert.ok(calls.every(c => c.signal.aborted));
  calls.forEach(c => c.releaseAbort());
  await closing;
  assert.equal(q.runningCount(), 0);
  assert.deepEqual(statuses(q.getBatch(snap.batchId)), [S.CANCELLED, S.CANCELLED, S.CANCELLED]);
  assert.throws(() => q.createBatch(urls('D')), e => e.code === 'QUEUE_CLOSED');
});

// ─── 5. the REAL discovery path (discoverYouTube + runYtDlpSource + killProcessTree) with a fake spawn ──────────────
function fakeSpawn({ hangFor = new Set(), failFor = new Set(), missingFor = new Set() } = {}) {
  const procs = [];
  const spawnImpl = (bin, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = undefined; // → killProcessTree falls back to proc.kill() (no taskkill in unit tests)
    proc.bin = bin; proc.args = args; proc.options = options; proc.killed = false; proc.closed = false;
    const url = args[0];
    const close = code => { if (proc.closed) return; proc.closed = true; proc.stdout.end(); proc.emit('close', code); };
    proc.kill = () => { proc.killed = true; queueMicrotask(() => close(1)); return true; };
    procs.push(proc);
    if ([...hangFor].some(h => url.includes(h))) { proc.stderr.write('[debug] page 1: Downloading API JSON\n'); return proc; }
    setTimeout(() => {
      if ([...failFor].some(h => url.includes(h))) { proc.stderr.write('ERROR: [youtube:tab] Unable to download API page: HTTP Error 404: Not Found\n'); close(1); return; }
      // real yt-dlp wording for a channel that does not exist (the single-URL discovery reads it as "tab unavailable")
      if ([...missingFor].some(h => url.includes(h))) { proc.stderr.write('ERROR: [youtube:tab] @ghost: This channel does not exist.\n'); close(1); return; }
      const handle = /@([^/]+)/.exec(url)?.[1] ?? 'x';
      const tab = /\/(videos|shorts|streams)$/.exec(url)?.[1];
      const lines = tab === 'videos' ? [0, 1].map(i => JSON.stringify({ id: `${i}${handle}`.padEnd(11, 'z').slice(0, 11), title: `${handle} ${i}`, playlist_uploader: handle, playlist_channel_id: `UC${handle}`.padEnd(24, 'q') })) : [];
      if (lines.length) proc.stdout.write(`${lines.join('\n')}\n`);
      close(0);
    }, 2);
    return proc;
  };
  return { procs, spawnImpl };
}

test('REAL path: several channels through discoverYouTube; structured argv, no shell, failure isolated, running channel cancelled by tree kill, no orphan', async () => {
  const { procs, spawnImpl } = fakeSpawn({ hangFor: new Set(['@hang']), failFor: new Set(['@broken']), missingFor: new Set(['@ghost']) });
  const discover = (input, opts) => discoverYouTube(input, { ...opts, spawnImpl, killSettleMs: 50 });
  const q = createChannelDiscoveryQueue({ discover, concurrency: 2 });
  const snap = q.createBatch('https://www.youtube.com/@alpha\nhttps://www.youtube.com/@broken\nyoutube.com/@hang/videos\nhttps://www.youtube.com/@gamma\nhttps://www.youtube.com/@ghost');
  await waitFor(() => q.getBatch(snap.batchId).jobs[2].status === S.RUNNING, '@hang running', 5000);
  const hang = q.getBatch(snap.batchId).jobs[2];
  q.cancelJob(snap.batchId, hang.id);
  await waitFor(() => !q.getBatch(snap.batchId).summary.active && q.runningCount() === 0, 'all settled', 5000);
  const end = q.getBatch(snap.batchId);
  assert.deepEqual(statuses(end), [S.COMPLETED, S.FAILED, S.CANCELLED, S.COMPLETED, S.FAILED]);
  assert.equal(end.jobs[1].error.code, 'YTDLP_ERROR');
  assert.equal(end.jobs[4].error.code, 'CHANNEL_UNAVAILABLE', 'a channel that does not exist is an error for that line, not "0 items, done"');
  assert.equal(end.jobs[4].retryable, true);
  assert.equal(q.getJobResult(snap.batchId, end.jobs[0].id).items.length, 2);
  assert.equal(q.getJobResult(snap.batchId, end.jobs[3].id).items.length, 2);
  assert.equal(end.jobs[0].channelId, 'UCalpha'.padEnd(24, 'q'));

  for (const proc of procs) {
    assert.ok(Array.isArray(proc.args), 'argv is an array');
    assert.ok(/^https:\/\/www\.youtube\.com\/@[a-z]+\/(videos|shorts|streams)$/.test(proc.args[0]), `URL is ONE argv element: ${proc.args[0]}`);
    assert.ok(proc.args.includes('--flat-playlist') && proc.args.includes('-v'), 'same argv as single-URL discovery');
    assert.notEqual(proc.options?.shell, true, 'never a shell');
    assert.equal(proc.closed, true, `process for ${proc.args[0]} is gone (no orphan)`);
  }
  const hangProc = procs.find(p => p.args[0].includes('@hang'));
  assert.equal(hangProc.killed, true, 'the running yt-dlp of the cancelled channel was killed');
  assert.ok(procs.filter(p => !p.args[0].includes('@hang')).every(p => !p.killed), 'the other channels were not touched');
  assert.equal(procs.filter(p => p.args[0].includes('@broken')).length, 1, 'a failing channel stops at its first listing');
  await q.close();
});

// ─── 6. HTTP routes ─────────────────────────────────────────────────────────────────────────────────────────────────
test('routes: create / poll / items / cancel one / retry / cancel all, explicit error codes; single-URL /capture/discover unchanged', async () => {
  const { calls, discover } = fakeDiscover();
  const youtubeChannelQueue = createChannelDiscoveryQueue({ discover, concurrency: 1 });
  const app = new Hono();
  app.route('/', createCaptureRoute({ services: { youtubeChannelQueue }, logger: null }));
  const req = (method, path, body) => app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  assert.equal((await req('POST', '/capture/discover/channels', { text: '' })).status, 400);
  assert.equal((await req('POST', '/capture/discover/channels', {})).status, 400);
  const created = await (await req('POST', '/capture/discover/channels', { text: 'https://www.youtube.com/@A\nnope\nhttps://www.youtube.com/@B' })).json();
  assert.deepEqual(statuses(created), [S.RUNNING, S.FAILED, S.QUEUED]);
  assert.equal(created.concurrency, 1);
  const base = `/capture/discover/channels/${created.batchId}`;

  const cancelB = await req('POST', `${base}/jobs/${created.jobs[2].id}/cancel`);
  assert.equal(cancelB.status, 200);
  assert.equal((await cancelB.json()).jobs[2].status, S.CANCELLED);
  assert.equal((await req('GET', `${base}/jobs/${created.jobs[0].id}/items`)).status, 409, 'not completed yet');

  calls[0].done(items('a', 2), { uploader: 'A' });
  await waitFor(() => youtubeChannelQueue.getBatch(created.batchId).jobs[0].status === S.COMPLETED, 'A done');
  const polled = await (await req('GET', base)).json();
  assert.equal(polled.summary.completed, 1);
  assert.equal(polled.summary.cancelled, 1);
  assert.equal(polled.summary.failed, 1);
  assert.equal('items' in polled.jobs[0], false, 'snapshots never carry the item lists (they can be thousands)');
  const grouped = await (await req('GET', `${base}/jobs/${created.jobs[0].id}/items`)).json();
  assert.equal(grouped.items.length, 2);
  assert.equal(grouped.channel.uploader, 'A');

  assert.equal((await req('POST', `${base}/jobs/${created.jobs[0].id}/cancel`)).status, 409, 'cancel after completion');
  const retried = await req('POST', `${base}/jobs/${created.jobs[2].id}/retry`);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).jobs[2].status, S.RUNNING);
  const all = await (await req('POST', `${base}/cancel`)).json();
  assert.equal(all.jobs[2].status, S.CANCELLED);
  calls.at(-1).releaseAbort();
  assert.equal((await req('GET', '/capture/discover/channels/unknown')).status, 404);
  assert.equal((await req('POST', `${base}/jobs/unknown/retry`)).status, 404);

  // the historical single-URL route still answers exactly as before
  const single = await req('POST', '/capture/discover', { input: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' });
  assert.equal(single.status, 200);
  const events = (await single.text()).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(events.map(e => e.type), ['start', 'mode', 'items_batch', 'done']);
  await youtubeChannelQueue.close();
});

test('friendlyError: a page-level 404 is no longer mislabelled as an age restriction ("page" contains "age")', async () => {
  const { friendlyError } = await import('./src/lib/ytdlp.js');
  assert.equal(friendlyError('ERROR: [youtube:tab] Unable to download API page: HTTP Error 404: Not Found'), 'Contenu introuvable (chaîne, vidéo ou page inexistante)');
  assert.equal(friendlyError('ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate'), 'Vidéo restreinte — connexion requise');
  assert.equal(friendlyError('ERROR: age-restricted video'), 'Vidéo restreinte — connexion requise');
  assert.equal(friendlyError('ERROR: [youtube] x: Private video'), 'Vidéo privée — impossible de télécharger', 'earlier mappings unchanged');
  assert.equal(friendlyError('ERROR: [youtube] x: Video unavailable'), 'Vidéo supprimée ou indisponible');
  assert.equal(friendlyError('ERROR: something else entirely'), 'ERROR: something else entirely', 'unknown errors still shown verbatim');
});

// ─── 7. static audit ────────────────────────────────────────────────────────────────────────────────────────────────
test('static audit: the queue never spawns, never shells out, never builds a command string; it reuses discoverYouTube; no item cap', () => {
  const text = fs.readFileSync(new URL('./src/lib/youtube-channel-queue.js', import.meta.url), 'utf8');
  const code = text.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /child_process|(?<![.\w])(spawn|exec|execFile|execSync|spawnSync)\(|shell\s*:|YTDLP_BIN|prepareYtDlp|fetch\(/);
  assert.match(code, /import \{ classifyDiscoveryInput, discoverYouTube \} from '\.\/youtube-discovery\.js'/);
  assert.doesNotMatch(code, /--playlist-end|--playlist-items|--max-downloads|MAX_ITEMS|MAX_RESULTS/);
  const route = fs.readFileSync(new URL('./src/routes/capture.js', import.meta.url), 'utf8');
  const block = route.slice(route.indexOf('YouTube Multi-Channel V1'), route.indexOf("route.post('/capture/playlist'"));
  assert.doesNotMatch(block, /spawn|exec|child_process|YTDLP_BIN/);
  const server = fs.readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  assert.match(server, /shutdownDefaultChannelQueue\(\)/, 'server stop tree-kills running discoveries');
});
