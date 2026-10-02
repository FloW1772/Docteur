// CERTIFICATION HARNESS — Smart Discovery V2 through the REAL cortex-server route (isolated temp SQLite + LanceDB, Ollama unreachable)
// with real yt-dlp (public metadata only). Measures transport timeline, cancel latency, process-tree termination (orphan count),
// the real watchdog kill, and that the local request guard still protects the route.
// Usage: node v2-real-server.mjs [url-shorts] [handle-root]       (never run two yt-dlp harnesses at once: it counts yt-dlp.exe processes)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const SHORTS = process.argv[2] ?? 'https://www.youtube.com/@Ines-n9m/shorts';
const ROOT = process.argv[3] ?? 'https://www.youtube.com/@Ines-n9m';
const OUT = path.resolve('..', 'reports', 'v2-real-server-results.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ytdlpCount = () => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH'], { encoding: 'utf8' }).split('\n').filter(l => /yt-dlp\.exe/i.test(l)).length; } catch { return 0; } };
const killTree = pid => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
const killAllYtdlp = () => { try { execFileSync('taskkill', ['/IM', 'yt-dlp.exe', '/T', '/F'], { stdio: 'ignore' }); } catch { /* none */ } };
const R = { generatedAt: new Date().toISOString(), shorts: SHORTS, root: ROOT, ollamaUrl: 'http://127.0.0.1:9 (unreachable)', tests: {} };

function boot(port, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-real-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), SQLITE_PATH: path.join(tmp, 'a.sqlite'), LANCEDB_PATH: path.join(tmp, 'a.lance'), OLLAMA_URL: 'http://127.0.0.1:9', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  return { child, tmp, base: `http://127.0.0.1:${port}`, log: () => log };
}
async function waitUp(srv, ms = 120_000) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(`${srv.base}/api/ping`)).ok) return true; } catch { /* boot */ } await sleep(400); } return false; }

// NDJSON client with timestamps; optional abort trigger (predicate on events or fixed delay)
async function discover(srv, body, { abortWhen = null, abortAfterMs = null, headers = {} } = {}) {
  const t0 = performance.now(); const now = () => Math.round(performance.now() - t0); const ctrl = new AbortController();
  const T = { status: null, events: [], phases: [], firstEventMs: null, firstProgressMs: null, firstItemsMs: null, marks: {}, total: 0, items: [], doneMs: null, error: null, abortedAtMs: null, doneParseMs: null, lines: 0 };
  if (abortAfterMs) setTimeout(() => { T.abortedAtMs = now(); ctrl.abort(); }, abortAfterMs);
  try {
    const res = await fetch(`${srv.base}/api/capture/discover`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    T.status = res.status;
    if (!res.ok) { T.body = (await res.text()).slice(0, 200); return T; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    const handle = line => {
      if (!line.trim()) return; T.lines++; const ev = JSON.parse(line); T.firstEventMs ??= now(); T.events.push(ev.type);
      if (ev.type === 'phase_start') T.phases.push({ tab: ev.tab, startMs: now() });
      if (ev.type === 'progress') T.firstProgressMs ??= now();
      if (ev.type === 'items_batch') { T.firstItemsMs ??= now(); T.total += ev.items.length; T.items.push(...ev.items.map(i => i.id)); for (const m of [100, 500, 1000, 2000, 2500]) if (T.total >= m) T.marks[m] ??= now(); }
      if (ev.type === 'phase_done') { const p = T.phases.find(x => x.tab === ev.tab); if (p) { p.doneMs = now(); p.count = ev.count; p.available = ev.available; p.pages = ev.pages; } }
      if (ev.type === 'done') { T.doneMs = now(); T.doneEvent = { total: ev.total, counts: ev.counts, duplicates: ev.duplicates, durationMs: ev.durationMs, merged: ev.merged?.length }; }
      if (ev.type === 'error') T.error = { name: ev.name, code: ev.code, message: ev.message, atMs: now() };
      if (ev.type === 'cancelled') T.cancelledEventMs = now();
      if (abortWhen && !T.abortedAtMs && abortWhen(ev, T)) { T.abortedAtMs = now(); ctrl.abort(); }
    };
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() ?? ''; for (const l of lines) handle(l); }
    if (buf.trim()) handle(buf);
  } catch (e) { T.clientError = `${e.name}: ${e.message}`; }
  T.endMs = now(); T.unique = new Set(T.items).size; delete T.items; return T;
}
// time until the yt-dlp.exe process count is back to the baseline (every tree member gone)
async function processesGoneMs(baseline, fromMs, limitMs = 60_000) { const t = performance.now(); const samples = []; while (performance.now() - t < limitMs) { const n = ytdlpCount(); samples.push(n); if (n <= baseline) return { goneAfterMs: Math.round(performance.now() - t) + fromMs, remaining: n, samples: samples.length }; await sleep(250); } return { goneAfterMs: null, remaining: ytdlpCount(), samples: samples.length }; }

async function directCount(url) {
  const bin = fs.existsSync('bin/yt-dlp.exe') ? 'bin/yt-dlp.exe' : 'yt-dlp.exe'; const t0 = Date.now();
  return new Promise(resolve => { const p = spawn(bin, [url, '--flat-playlist', '--dump-json', '--no-warnings', '--no-playlist-reverse'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); let buf = ''; const ids = new Set(); let lines = 0; p.stdout.on('data', d => { buf += d; const parts = buf.split('\n'); buf = parts.pop() ?? ''; for (const l of parts) { if (!l.trim()) continue; lines++; try { ids.add(JSON.parse(l).id); } catch { /* skip */ } } }); p.on('close', () => resolve({ lines, unique: ids.size, ms: Date.now() - t0 })); });
}

killAllYtdlp(); await sleep(500);
const baseline = ytdlpCount(); R.baselineYtdlp = baseline;
let srv; let srv2;
try {
  srv = boot(3946); R.booted = await waitUp(srv); if (!R.booted) throw new Error(`boot failed: ${srv.log().slice(-400)}`);
  R.health = await fetch(`${srv.base}/api/health`).then(r => r.json()).then(h => ({ ollama_connected: h.ollama_connected })).catch(e => ({ error: e.message }));

  // ── guard: the route keeps the local protections (NB-6/NB-7) and validates input ──
  R.tests.guard = {
    foreignOrigin: (await discover(srv, { input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { headers: { origin: 'https://evil.example' } })).status,
    invalidUrl: (await discover(srv, { input: 'https://evil.example/@x' })).status,
    bareHandleNoContext: (await discover(srv, { input: '@Ines-n9m' })).status,
    singleShortNoYtdlp: await discover(srv, { input: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }).then(t => ({ status: t.status, events: t.events, ytdlpAfter: ytdlpCount() })),
    liveUrl: await discover(srv, { input: 'https://www.youtube.com/@Ines-n9m/live' }).then(t => ({ status: t.status, error: t.error })),
  };
  console.log('guard', JSON.stringify(R.tests.guard));

  // ── cancel during the silent crawl of a huge Shorts tab: process tree must die immediately ──
  {
    const T = await discover(srv, { input: SHORTS }, { abortAfterMs: 15_000 });
    const gone = await processesGoneMs(baseline, 0, 30_000);
    R.tests.cancel_shorts_silent_crawl = { client: { abortedAtMs: T.abortedAtMs, clientError: T.clientError, events: T.events }, processTreeGone: gone };
    console.log('cancel shorts', JSON.stringify(R.tests.cancel_shorts_silent_crawl));
    await sleep(500);
  }

    // root: cancel 8 s after the shorts phase begins (events arrive at phase boundaries; we poll with a timer)
    {
      const ctrl = { abortAt: null };
      const t0 = performance.now(); let shortsAt = null; let abortedAt = null; const events = [];
      const ac = new AbortController();
      const res = await fetch(`${srv.base}/api/capture/discover`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ input: ROOT }), signal: ac.signal });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      const timer = setInterval(() => { if (shortsAt && !abortedAt && performance.now() - shortsAt > 8000) { abortedAt = performance.now(); ac.abort(); } }, 100);
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const ls = buf.split('\n'); buf = ls.pop() ?? ''; for (const l of ls) { if (!l.trim()) continue; const ev = JSON.parse(l); events.push(ev.type === 'phase_start' || ev.type === 'phase_done' ? `${ev.type}:${ev.tab}` : ev.type); if (ev.type === 'phase_start' && ev.tab === 'shorts') shortsAt = performance.now(); } }
      } catch { /* aborted */ }
      clearInterval(timer);
      const gone = await processesGoneMs(baseline, 0, 30_000);
      R.tests.cancel_root_during_shorts = { shortsPhaseStartedMs: shortsAt ? Math.round(shortsAt - t0) : null, abortedAtMs: abortedAt ? Math.round(abortedAt - t0) : null, events: [...new Set(events)], streamsPhaseStarted: events.includes('phase_start:streams'), processTreeGone: gone };
      console.log('cancel root', JSON.stringify(R.tests.cancel_root_during_shorts));
      await sleep(500);
    }

    // real watchdog: a server whose stall limit is 200 ms kills the REAL yt-dlp tree (bootloader start-up is silent for > 200 ms)
    {
      srv2 = boot(3947, { DOCTEUR_YTDLP_STALL_MS: '200' });
      if (!(await waitUp(srv2))) throw new Error('server2 boot failed');
      const t0 = performance.now();
      const T = await discover(srv2, { input: SHORTS });
      const gone = await processesGoneMs(baseline, 0, 30_000);
      R.tests.real_watchdog_kill = { stallMs: 200, error: T.error, events: T.events, durationMs: Math.round(performance.now() - t0), processTreeGone: gone };
      console.log('real watchdog', JSON.stringify(R.tests.real_watchdog_kill));
    }

    // full Shorts discovery through the route, parity with a direct run measured right before
    {
      const direct = await directCount(SHORTS);
      let peak = 0; const sm = setInterval(() => { try { const o = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${srv.child.pid}).WorkingSet64/1MB`], { encoding: 'utf8', windowsHide: true }); peak = Math.max(peak, Number(o)); } catch { /* ignore */ } }, 4000);
      const T = await discover(srv, { input: SHORTS }, { });
      clearInterval(sm);
      R.tests.full_shorts_through_route = { direct, docteur: { total: T.total, unique: T.unique, doneEvent: T.doneEvent, status: T.status, error: T.error, firstEventMs: T.firstEventMs, firstProgressMs: T.firstProgressMs, firstItemsMs: T.firstItemsMs, marks: T.marks, doneMs: T.doneMs, phases: T.phases, lines: T.lines }, parity: { direct: direct.unique, docteur: T.unique, diff: T.unique - direct.unique, pass: T.unique === direct.unique && !T.error }, serverRssPeakMb: +peak.toFixed(1), ytdlpAfter: ytdlpCount() };
      console.log('full shorts', JSON.stringify({ parity: R.tests.full_shorts_through_route.parity, docteurMs: T.doneMs, directMs: direct.ms, first: T.firstItemsMs, rss: peak }));
    }
    R.serverLogTail = srv.log().split('\n').filter(l => /YOUTUBE_DISCOVERY|error/i.test(l)).slice(-6).map(l => l.slice(0, 260));
  } catch (e) { R.fatal2 = e.stack; } finally {
    killAllYtdlp();
    for (const s of [srv, srv2]) if (s) { killTree(s.child.pid); }
    await sleep(1000);
    for (const s of [srv, srv2]) if (s) { try { fs.rmSync(s.tmp, { recursive: true, force: true }); } catch { /* locked */ } }
    R.ytdlpAtEnd = ytdlpCount();
    fs.writeFileSync(OUT, JSON.stringify(R, null, 1)); console.log('written', OUT); process.exit(0);
  }

