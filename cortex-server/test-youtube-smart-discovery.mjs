import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import {
  classifyDiscoveryInput, discoverYouTube, runYtDlpSource, DISCOVERY_MODES as M,
} from './src/lib/youtube-discovery.js';
import { killProcessTree } from './src/lib/process-tree.js';
import { createCaptureRoute } from './src/routes/capture.js';

const HANDLE = 'https://www.youtube.com/@example';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── fake yt-dlp ──────────────────────────────────────────────────────────────────────────────────────
// plans: map url-suffix (videos|shorts|streams|playlist) → { entries, stderrAtStart, heartbeatMs, silentMs, exitCode, stderr, hang, ignoreKill }
function entry(id, extra = {}) { return { id, title: `T ${id}`, playlist_title: 'Coll', playlist_uploader: 'Example', playlist_id: 'UCexample', ...extra }; }
function ids(prefix, n) { return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(6, '0')}`.slice(0, 11).padEnd(11, 'x')); }

function makeSpawn(plans, calls = []) {
  return (_bin, args) => {
    const url = args[0];
    const tab = /\/(videos|shorts|streams)$/.exec(url)?.[1] ?? 'playlist';
    const plan = plans[tab] ?? { entries: [] };
    calls.push({ url, tab, args, proc: null });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = undefined;
    proc.killCalls = 0;
    calls.at(-1).proc = proc;
    const timers = [];
    let closed = false;
    const close = code => { if (closed) return; closed = true; timers.forEach(clearTimeout); timers.forEach(clearInterval); proc.stdout.end(); proc.emit('close', code); };
    proc.kill = () => { proc.killCalls += 1; if (!plan.ignoreKill) queueMicrotask(() => close(1)); return true; };
    if (plan.hang) return proc; // totally silent forever
    proc.stderr.write('[debug] Command-line config: [...]\n');
    let page = 0;
    if (plan.heartbeatMs) {
      const hb = setInterval(() => { page += 1; proc.stderr.write(`[youtube:tab] UCexample: page ${page}: Downloading API JSON\n`); }, plan.heartbeatMs);
      timers.push(hb);
    }
    timers.push(setTimeout(() => {
      if (closed) return;
      if (plan.stderr) proc.stderr.write(plan.stderr);
      const lines = (plan.entries ?? []).map(e => `${JSON.stringify(e)}\n`).join('');
      if (lines) proc.stdout.write(lines);
      close(plan.exitCode ?? 0);
    }, plan.silentMs ?? 0));
    return proc;
  };
}

async function run(input, plans, options = {}) {
  const calls = [];
  const events = [];
  const result = await discoverYouTube(input, { spawnImpl: makeSpawn(plans, calls), onEvent: e => events.push(e), ...options });
  return { result, events, calls };
}

// ─── classification ───────────────────────────────────────────────────────────────────────────────────
test('classifies channel roots, tabs, handles, singles and playlists', () => {
  const cases = [
    ['https://www.youtube.com/@Ines-n9m', M.ALL_MEDIA],
    ['https://youtube.com/@Ines-n9m', M.ALL_MEDIA],
    ['https://www.youtube.com/@Ines-n9m/', M.ALL_MEDIA],
    ['https://www.youtube.com/@Ines-n9m?si=abc', M.ALL_MEDIA],
    ['https://www.youtube.com/@Ines-n9m/featured', M.ALL_MEDIA],
    ['https://www.youtube.com/@Ines-n9m/videos', M.VIDEOS_ONLY],
    ['https://www.youtube.com/@Ines-n9m/videos/', M.VIDEOS_ONLY],
    ['https://www.youtube.com/@Ines-n9m/shorts', M.SHORTS_ONLY],
    ['https://www.youtube.com/@Ines-n9m/streams', M.STREAMS_ONLY],
    ['https://www.youtube.com/@Ines-n9m/live', M.CHANNEL_LIVE],
    ['https://www.youtube.com/channel/UCkVv-e3hXZd_V2CTQSgsmSg', M.ALL_MEDIA],
    ['https://www.youtube.com/channel/UCkVv-e3hXZd_V2CTQSgsmSg/shorts', M.SHORTS_ONLY],
    ['https://www.youtube.com/c/SomeName/videos', M.VIDEOS_ONLY],
    ['https://www.youtube.com/user/SomeName/streams', M.STREAMS_ONLY],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', M.SINGLE_VIDEO],
    ['https://youtu.be/dQw4w9WgXcQ', M.SINGLE_VIDEO],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', M.SINGLE_SHORT],
    ['https://www.youtube.com/playlist?list=PLNaAc9o-jKVBmldLkcbdGexi9eqjjALwf', M.PLAYLIST_ONLY],
  ];
  for (const [input, mode] of cases) assert.equal(classifyDiscoveryInput(input).mode, mode, input);
});

test('URL intent is never rewritten: tab preserved in the canonical URL and sources', () => {
  assert.equal(classifyDiscoveryInput(`${HANDLE}/shorts`).canonicalUrl, `${HANDLE}/shorts`);
  assert.deepEqual(classifyDiscoveryInput(`${HANDLE}/shorts`).sources.map(s => s.tab), ['shorts']);
  assert.deepEqual(classifyDiscoveryInput(`${HANDLE}/videos`).sources.map(s => s.tab), ['videos']);
  assert.deepEqual(classifyDiscoveryInput(`${HANDLE}/streams`).sources.map(s => s.tab), ['streams']);
  assert.deepEqual(classifyDiscoveryInput(HANDLE).sources.map(s => s.tab), ['videos', 'shorts', 'streams']);
  assert.deepEqual(classifyDiscoveryInput(HANDLE).sources.map(s => s.url), [`${HANDLE}/videos`, `${HANDLE}/shorts`, `${HANDLE}/streams`]);
  assert.deepEqual(classifyDiscoveryInput('https://youtu.be/dQw4w9WgXcQ').sources, []);
  assert.deepEqual(classifyDiscoveryInput('https://www.youtube.com/shorts/dQw4w9WgXcQ').sources, []);
});

test('bare @handle is accepted only inside an explicit YouTube workflow', () => {
  assert.equal(classifyDiscoveryInput('@Ines-n9m').ok, false);
  assert.equal(classifyDiscoveryInput('@Ines-n9m').reason, 'bare_handle_not_allowed');
  for (const raw of ['@Ines-n9m', '/@Ines-n9m', '@Ines-n9m/', '@Ines-n9m/videos', '/@Ines-n9m/shorts', '@Ines-n9m/streams']) {
    assert.equal(classifyDiscoveryInput(raw, { allowBareHandle: true }).ok, true, raw);
  }
  const root = classifyDiscoveryInput('@Ines-n9m', { allowBareHandle: true });
  assert.equal(root.mode, M.ALL_MEDIA);
  assert.equal(root.canonicalUrl, 'https://www.youtube.com/@Ines-n9m');
  assert.equal(root.handle, '@Ines-n9m');
  assert.equal(classifyDiscoveryInput('@Ines-n9m/shorts', { allowBareHandle: true }).mode, M.SHORTS_ONLY);
});

test('unicode handles are kept; hostile or malformed input is rejected', () => {
  const uni = classifyDiscoveryInput('https://www.youtube.com/@%E3%83%86%E3%82%B9%E3%83%88');
  assert.equal(uni.ok, true);
  assert.equal(uni.handle, '@テスト');
  assert.equal(classifyDiscoveryInput('@テスト', { allowBareHandle: true }).ok, true);
  for (const bad of ['', '   ', 'https://evil.example/@x', 'javascript:alert(1)', 'https://www.youtube.com/@a b', 'https://www.youtube.com/@x/playlists',
    'https://www.youtube.com/@x/videos/extra', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/', 'https://www.youtube.com/@x;rm -rf /', `https://www.youtube.com/@${'a'.repeat(300)}`]) {
    assert.equal(classifyDiscoveryInput(bad, { allowBareHandle: true }).ok, false, bad);
  }
});

// ─── dispatch ─────────────────────────────────────────────────────────────────────────────────────────
test('dispatch: root → videos+shorts+streams; each tab alone → that tab only; never --playlist-end', async () => {
  const plans = { videos: { entries: [entry('vvvvvvvvv01')] }, shorts: { entries: [entry('sssssssss01')] }, streams: { entries: [entry('lllllllll01')] } };
  const root = await run(HANDLE, plans);
  assert.deepEqual(root.calls.map(c => c.tab), ['videos', 'shorts', 'streams']);
  assert.deepEqual(root.calls.map(c => c.url), [`${HANDLE}/videos`, `${HANDLE}/shorts`, `${HANDLE}/streams`]);
  for (const call of [...root.calls]) {
    assert.ok(!call.args.includes('--playlist-end'));
    assert.ok(call.args.includes('--flat-playlist'));
  }
  assert.equal(root.result.total, 3);
  for (const tab of ['videos', 'shorts', 'streams']) {
    const only = await run(`${HANDLE}/${tab}`, plans);
    assert.deepEqual(only.calls.map(c => c.tab), [tab]);
    assert.equal(only.result.total, 1);
    assert.ok(only.result.items.every(i => i.sourceTab === tab));
  }
});

test('typed items: mediaType, sourceTab, sourceChannel, canonical URL form per type; /shorts stays /shorts', async () => {
  const plans = {
    videos: { entries: [entry('vvvvvvvvv01', { thumbnails: [{ url: 'https://i.ytimg.com/a.jpg' }] })] },
    shorts: { entries: [entry('sssssssss01')] },
    streams: { entries: [entry('lllllllll01')] },
  };
  const { result } = await run(HANDLE, plans);
  const byId = Object.fromEntries(result.items.map(i => [i.id, i]));
  assert.equal(byId.vvvvvvvvv01.mediaType, 'VIDEO');
  assert.equal(byId.vvvvvvvvv01.url, 'https://www.youtube.com/watch?v=vvvvvvvvv01');
  assert.equal(byId.vvvvvvvvv01.thumbnail, 'https://i.ytimg.com/a.jpg');
  assert.equal(byId.sssssssss01.mediaType, 'SHORT');
  assert.equal(byId.sssssssss01.url, 'https://www.youtube.com/shorts/sssssssss01');
  assert.equal(byId.lllllllll01.mediaType, 'STREAM');
  assert.equal(byId.lllllllll01.sourceTab, 'streams');
  for (const item of result.items) { assert.equal(item.sourceChannel, 'Example'); assert.ok(item.title); }
});

test('single video / single Short / /live never start a channel discovery', async () => {
  const video = await run('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {});
  const short = await run('https://www.youtube.com/shorts/dQw4w9WgXcQ', {});
  const live = await run(`${HANDLE}/live`, {});
  assert.equal(video.calls.length + short.calls.length + live.calls.length, 0);
  assert.equal(video.result.items[0].mediaType, 'VIDEO');
  assert.equal(short.result.items[0].url, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(short.result.items[0].mediaType, 'SHORT');
  assert.equal(live.events.at(-1).code, 'UNSUPPORTED_MODE');
  assert.equal(video.events.at(0).type, 'start');
});

test('playlist stays a playlist: one source, no cap, no channel expansion', async () => {
  const list = ids('p', 350).map(id => entry(id));
  const { result, calls } = await run('https://www.youtube.com/playlist?list=PLabc12345', { playlist: { entries: list } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.youtube.com/playlist?list=PLabc12345');
  assert.equal(result.total, 350);
  assert.equal(result.mode, M.PLAYLIST_ONLY);
});

// ─── no cap, dedup, order ─────────────────────────────────────────────────────────────────────────────
test('no hidden cap: 5 000 Shorts all arrive; events carry them in technical batches only', async () => {
  const list = ids('s', 5000).map(id => entry(id));
  const { result, events } = await run(`${HANDLE}/shorts`, { shorts: { entries: list } });
  assert.equal(result.total, 5000);
  const batched = events.filter(e => e.type === 'items_batch');
  assert.equal(batched.reduce((n, e) => n + e.items.length, 0), 5000);
  assert.ok(batched.every(e => e.items.length <= 100));
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.total, 5000);
});

test('dedup by videoId across tabs: one item, sourceTabs kept, richer type wins, tab order stable', async () => {
  const plans = {
    videos: { entries: [entry('aaaaaaaaaa1'), entry('bbbbbbbbbb1'), entry('aaaaaaaaaa1')] },
    shorts: { entries: [entry('bbbbbbbbbb1'), entry('cccccccccc1')] },
    streams: { entries: [entry('cccccccccc1'), entry('dddddddddd1')] },
  };
  const { result, events } = await run(HANDLE, plans);
  assert.deepEqual(result.items.map(i => i.id), ['aaaaaaaaaa1', 'bbbbbbbbbb1', 'cccccccccc1', 'dddddddddd1']);
  assert.equal(result.total, 4);
  assert.equal(result.duplicates, 3); // 1 intra-tab + 2 cross-tab
  const b = result.items.find(i => i.id === 'bbbbbbbbbb1');
  assert.deepEqual(b.sourceTabs, ['videos', 'shorts']);
  assert.equal(b.mediaType, 'SHORT');
  assert.equal(b.url, 'https://www.youtube.com/shorts/bbbbbbbbbb1');
  const done = events.at(-1);
  assert.ok(done.merged.some(m => m.id === 'bbbbbbbbbb1' && m.mediaType === 'SHORT'), 'merge info delivered for items already streamed');
  assert.equal(new Set(result.items.map(i => i.id)).size, result.items.length);
});

test('dedup is linear: 60 000 entries (with 50 % duplicates) finish fast', async () => {
  const base = ids('z', 30_000);
  const list = [...base, ...base].map(id => entry(id));
  const t0 = performance.now();
  const { result } = await run(`${HANDLE}/videos`, { videos: { entries: list } });
  const ms = performance.now() - t0;
  assert.equal(result.total, 30_000);
  assert.ok(ms < 8000, `dedup took ${ms} ms`);
});

test('explicit tab keeps the yt-dlp order', async () => {
  const order = ['zzzzzzzzzz1', 'aaaaaaaaaa1', 'mmmmmmmmmm1'];
  const { result } = await run(`${HANDLE}/shorts`, { shorts: { entries: order.map(i => entry(i)) } });
  assert.deepEqual(result.items.map(i => i.id), order);
});

// ─── events ───────────────────────────────────────────────────────────────────────────────────────────
test('events: start, mode, phase_start/phase_done per source, items before done, done last', async () => {
  const plans = { videos: { entries: [entry('vvvvvvvvv01')], heartbeatMs: 5, silentMs: 40 }, shorts: { entries: [entry('sssssssss01')] }, streams: { entries: [] } };
  const { events } = await run(HANDLE, plans);
  const types = events.map(e => e.type);
  assert.equal(types[0], 'start');
  assert.equal(types[1], 'mode');
  assert.equal(events[1].mode, M.ALL_MEDIA);
  assert.deepEqual(events.filter(e => e.type === 'phase_start').map(e => e.tab), ['videos', 'shorts', 'streams']);
  assert.deepEqual(events.filter(e => e.type === 'phase_done').map(e => e.tab), ['videos', 'shorts', 'streams']);
  assert.equal(types.at(-1), 'done');
  assert.ok(types.includes('progress'));
  // the videos batch is published before the shorts phase starts
  const firstBatch = types.indexOf('items_batch');
  const shortsStart = events.findIndex(e => e.type === 'phase_start' && e.tab === 'shorts');
  assert.ok(firstBatch > -1 && firstBatch < shortsStart);
  const prog = events.find(e => e.type === 'progress' && e.pages > 0);
  assert.ok(prog, 'page progress derived from the yt-dlp heartbeat');
});

test('a channel without a streams tab is reported unavailable, not as a failure', async () => {
  const plans = {
    videos: { entries: [entry('vvvvvvvvv01')] }, shorts: { entries: [entry('sssssssss01')] },
    streams: { entries: [], exitCode: 1, stderr: 'ERROR: [youtube:tab] example: This channel does not have a streams tab\n' },
  };
  const { result, events } = await run(HANDLE, plans);
  assert.equal(result.status, 'done');
  assert.equal(result.total, 2);
  assert.equal(events.find(e => e.type === 'phase_done' && e.tab === 'streams').available, false);
  const only = await run(`${HANDLE}/streams`, plans);
  assert.equal(only.result.status, 'done');
  assert.equal(only.result.total, 0);
});

test('a real yt-dlp failure is an error event with a clean message (no verbose noise), partial data not imported', async () => {
  const plans = { videos: { entries: [entry('vvvvvvvvv01')] }, shorts: { entries: [], exitCode: 1, stderr: '[debug] usage language package\nERROR: [youtube:tab] example: Video unavailable\n' }, streams: { entries: [] } };
  const { result, events, calls } = await run(HANDLE, plans);
  assert.equal(result.status, 'error');
  const err = events.at(-1);
  assert.equal(err.type, 'error');
  assert.match(err.message, /supprimée ou indisponible/);
  assert.equal(calls.length, 2, 'streams not started after the failure');
});

// ─── watchdog ─────────────────────────────────────────────────────────────────────────────────────────
// Real time is scaled (1 s of test ≈ 150 s of production): stallMs 200 ms stands for the 90 s production stall limit.
test('watchdog: a long silent stdout phase with a live heartbeat is NOT a timeout', async () => {
  const plans = { shorts: { entries: ids('s', 300).map(id => entry(id)), heartbeatMs: 40, silentMs: 1200 } };
  const t0 = Date.now();
  const { result, calls } = await run(`${HANDLE}/shorts`, plans, { stallMs: 250 });
  assert.ok(Date.now() - t0 >= 1100, 'the silent crawl lasted several stall windows');
  assert.equal(result.status, 'done');
  assert.equal(result.total, 300);
  assert.equal(calls[0].proc.killCalls, 0);
});

test('watchdog: a truly hung process (no stdout, no stderr) times out as DISCOVERY_STALLED and is killed', async () => {
  const { result, events, calls } = await run(`${HANDLE}/shorts`, { shorts: { hang: true } }, { stallMs: 150 });
  assert.equal(result.status, 'error');
  const err = events.at(-1);
  assert.equal(err.name, 'TimeoutError');
  assert.equal(err.code, 'DISCOVERY_STALLED');
  assert.match(err.message, /ne répond plus/);
  assert.equal(calls[0].proc.killCalls, 1);
});

test('watchdog: a process that stops emitting heartbeats mid-crawl is detected', async () => {
  const calls = [];
  const spawnImpl = (...a) => {
    const proc = makeSpawn({ shorts: { hang: true } }, calls)(...a);
    proc.stderr.write('[youtube:tab] UCx: page 1: Downloading API JSON\n');
    return proc;
  };
  const events = [];
  const t0 = Date.now();
  const result = await discoverYouTube(`${HANDLE}/shorts`, { spawnImpl, stallMs: 200, onEvent: e => events.push(e) });
  assert.equal(result.status, 'error');
  assert.equal(events.at(-1).code, 'DISCOVERY_STALLED');
  assert.ok(Date.now() - t0 >= 190);
});

test('max runtime is a separate guard: heartbeats forever still end with DISCOVERY_MAX_RUNTIME', async () => {
  const { result, events } = await run(`${HANDLE}/shorts`, { shorts: { entries: [], heartbeatMs: 20, silentMs: 60_000 } }, { stallMs: 5_000, maxRuntimeMs: 300 });
  assert.equal(result.status, 'error');
  assert.equal(events.at(-1).code, 'DISCOVERY_MAX_RUNTIME');
  assert.match(events.at(-1).message, /Durée maximale/);
});

test('if the kill does not close the process the call still settles (no eternal pending)', async () => {
  const t0 = Date.now();
  const { result } = await run(`${HANDLE}/shorts`, { shorts: { hang: true, ignoreKill: true } }, { stallMs: 100, killSettleMs: 200 });
  assert.equal(result.status, 'error');
  assert.ok(Date.now() - t0 < 2000);
});

// ─── cancel ───────────────────────────────────────────────────────────────────────────────────────────
test('cancel during a phase: process killed, cancelled event, later phases never start', async () => {
  const plans = { videos: { entries: [entry('vvvvvvvvv01')] }, shorts: { entries: [], heartbeatMs: 20, silentMs: 60_000 }, streams: { entries: [entry('lllllllll01')] } };
  const ctrl = new AbortController();
  const calls = [];
  const events = [];
  const p = discoverYouTube(HANDLE, { spawnImpl: makeSpawn(plans, calls), signal: ctrl.signal, onEvent: e => events.push(e), stallMs: 5000 });
  while (!calls.some(c => c.tab === 'shorts')) await sleep(10);
  await sleep(60);
  const t0 = Date.now();
  ctrl.abort();
  const result = await p;
  assert.ok(Date.now() - t0 < 500, 'cancel latency');
  assert.equal(result.status, 'cancelled');
  assert.equal(events.at(-1).type, 'cancelled');
  assert.equal(calls.some(c => c.tab === 'streams'), false);
  assert.equal(calls.find(c => c.tab === 'shorts').proc.killCalls, 1);
  assert.ok(!events.some(e => e.type === 'done' || e.type === 'error'));
});

test('an already-aborted signal starts nothing', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  const { result, calls } = await run(HANDLE, {}, { signal: ctrl.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.length, 0);
});

// ─── security ─────────────────────────────────────────────────────────────────────────────────────────
test('yt-dlp is always spawned with structured argv; the URL is a single element', async () => {
  const { calls } = await run(`${HANDLE}/videos?view=0&x=1;whoami`, { videos: { entries: [] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], `${HANDLE}/videos`);
  assert.equal(calls[0].args.filter(a => a.includes('whoami')).length, 0);
});

test('hostile input is rejected before any process is spawned', async () => {
  const { result, calls } = await run('https://evil.example/@x/shorts', {});
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_INPUT');
  assert.equal(calls.length, 0);
});

// ─── Windows process tree ─────────────────────────────────────────────────────────────────────────────
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('killProcessTree ends the parent AND its child on Windows (fake bootloader + worker)', { skip: process.platform !== 'win32' }, async () => {
  const childSrc = 'setInterval(() => {}, 1000);';
  const parentSrc = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(childSrc)}], { stdio: 'ignore' }); console.log('CHILD:' + c.pid); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', parentSrc], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const childPid = await new Promise(resolve => { parent.stdout.on('data', d => { const m = /CHILD:(\d+)/.exec(d.toString()); if (m) resolve(Number(m[1])); }); });
  assert.ok(alive(parent.pid) && alive(childPid));
  const t0 = Date.now();
  await killProcessTree(parent);
  await new Promise(r => parent.once('close', r));
  await sleep(300);
  const latency = Date.now() - t0;
  assert.equal(alive(parent.pid), false, 'parent gone');
  assert.equal(alive(childPid), false, 'child gone');
  assert.ok(latency < 5000, `tree kill latency ${latency} ms`);
});

test('killProcessTree falls back to proc.kill() for processes without a pid / off Windows', async () => {
  let killed = 0;
  await killProcessTree({ kill() { killed += 1; } });
  await killProcessTree({ pid: 1234, kill() { killed += 1; } }, { platform: 'linux' });
  assert.equal(killed, 2);
});

// ─── route ────────────────────────────────────────────────────────────────────────────────────────────
test('POST /capture/discover: validation, NDJSON events, bare handle only with youtube context', async () => {
  const app = new Hono();
  app.route('/', createCaptureRoute({ services: {}, logger: null }));
  const post = body => app.request('/capture/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await post({ input: 'https://evil.example/x' })).status, 400);
  assert.equal((await post({ input: '@Ines-n9m' })).status, 400, 'bare handle without YouTube context');
  assert.equal((await post({})).status, 400);

  const res = await post({ input: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);
  const events = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(events.map(e => e.type), ['start', 'mode', 'items_batch', 'done']);
  assert.equal(events[1].mode, 'SINGLE_SHORT');
  assert.equal(events.at(-1).total, 1);
  assert.equal('limit' in events[1], false);
});

test('runYtDlpSource: argv shape (verbose heartbeat, flat playlist, no limit flags)', async () => {
  const calls = [];
  await runYtDlpSource({ url: `${HANDLE}/shorts`, spawnImpl: makeSpawn({ shorts: { entries: [] } }, calls) });
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 1), [`${HANDLE}/shorts`]);
  for (const flag of ['--flat-playlist', '--dump-json', '--no-warnings', '--no-playlist-reverse', '-v']) assert.ok(args.includes(flag), flag);
  for (const forbidden of ['--playlist-end', '--playlist-items', '--max-downloads', '--cookies-from-browser', '--cookies', '-U', '--update']) assert.ok(!args.includes(forbidden), forbidden);
});

// ─── static audit: no hidden cap, no manual limit contract ───────────────────────────────────────────────────
test('static audit: no hidden item cap or limit flag in the V2 discovery path (lib, route, client, UI)', async () => {
  const fs = await import('node:fs');
  const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const route = read('./src/routes/capture.js');
  const routeV2 = route.slice(route.indexOf("route.post('/capture/discover'"), route.indexOf("route.post('/capture/playlist'"));
  const client = read('../src/lib/cortex/client.ts');
  const clientV2 = client.slice(client.indexOf('async discoverYouTube'), client.indexOf('async deleteNeuron'));
  const sources = {
    'youtube-discovery.js': read('./src/lib/youtube-discovery.js'),
    'process-tree.js': read('./src/lib/process-tree.js'),
    'route /capture/discover': routeV2,
    'client discoverYouTube': clientV2,
    'discovery-input.ts': read('../src/lib/youtube/discovery-input.ts'),
    'discovery-view.ts': read('../src/lib/youtube/discovery-view.ts'),
    'YouTubeDiscoveryPanel.tsx': read('../src/components/panels/YouTubeDiscoveryPanel.tsx'),
  };
  const forbidden = [/--playlist-end/, /--playlist-items/, /--max-downloads/, /MAX_ITEMS/, /MAX_RESULTS/, /\.slice\(0,\s*(25|50|100|200|500|1000|2000)\)/, /\.take\(\s*\d+\s*\)/, /requested_?[Ll]imit/, /limit_reached/, /mode:\s*'limited'/, /collectionLimit/];
  for (const [name, text] of Object.entries(sources)) {
    for (const re of forbidden) assert.equal(re.test(text), false, `${name} matches ${re}`);
  }
  assert.ok(sources['youtube-discovery.js'].includes('DEFAULT_BATCH_SIZE'), 'batch size is a technical event batch, documented');
});
