// AUDIT ONLY — REAL cortex-server route POST /api/capture/playlist on a large public Shorts channel (isolated temp SQLite + LanceDB,
// port 3945, Ollama deliberately UNREACHABLE to prove it is not on the discovery critical path). Real yt-dlp, metadata only.
// Measures the NDJSON transport timeline (started / progress / done), the size of the single `done` line and its client-side parse cost,
// and what a client disconnect does to yt-dlp (orphan check). Usage: node audit-shorts-server.mjs [url]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const URL_ = process.argv[2] ?? 'https://www.youtube.com/@Ines-n9m/shorts';
const PORT = 3945; const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-shorts-'));
const OUT = path.resolve('..', 'reports', 'audit-shorts-server-results.json');
const R = { generatedAt: new Date().toISOString(), url: URL_, port: PORT, ollamaUrl: 'http://127.0.0.1:9 (unreachable on purpose)', tests: {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ytdlpCount = () => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH'], { encoding: 'utf8' }).split('\n').filter(l => /yt-dlp\.exe/i.test(l)).length; } catch { return 0; } };
const killYtdlp = () => { try { execFileSync('taskkill', ['/IM', 'yt-dlp.exe', '/T', '/F'], { stdio: 'ignore' }); } catch { /* none */ } };
const kill = (child) => new Promise(res => { child.once('exit', () => res()); try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } setTimeout(res, 5000); });
const rssMb = (pid) => { try { const o = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64/1MB`], { encoding: 'utf8', windowsHide: true }); return +Number(o).toFixed(1); } catch { return null; } };

const srv = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), SQLITE_PATH: path.join(TMP, 'a.sqlite'), LANCEDB_PATH: path.join(TMP, 'a.lance'), OLLAMA_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });

// reads the NDJSON stream exactly like client.ts getPlaylist (reader + line split), with timestamps
async function discover(body, { abortAfterMs = null, maxMs = 400_000 } = {}) {
  const t0 = performance.now(); const now = () => Math.round(performance.now() - t0); const ctrl = new AbortController();
  const T = { firstByteMs: null, startedMs: null, firstProgressMs: null, progressEvents: 0, marks: {}, doneMs: null, doneLineBytes: null, doneParseMs: null, errorEvent: null, totalBytes: 0, status: null, contentType: null, aborted: false };
  const guard = setTimeout(() => ctrl.abort(), maxMs); if (abortAfterMs) setTimeout(() => { T.aborted = true; ctrl.abort(); }, abortAfterMs);
  try {
    const res = await fetch(`${BASE}/api/capture/playlist`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ url: URL_, ...body }), signal: ctrl.signal });
    T.status = res.status; T.contentType = res.headers.get('content-type'); T.headersMs = now();
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    const handle = (line) => {
      if (!line.trim()) return; const tp = performance.now(); const ev = JSON.parse(line);
      if (ev.type === 'started') T.startedMs = now();
      else if (ev.type === 'progress') { T.progressEvents++; if (T.firstProgressMs === null) T.firstProgressMs = now(); if ([1, 25, 50, 100, 500, 1000, 2000, 2500].includes(ev.count)) T.marks[ev.count] = now(); }
      else if (ev.type === 'done') { T.doneMs = now(); T.doneLineBytes = line.length; T.doneParseMs = +(performance.now() - tp).toFixed(1); T.returned = ev.result.video_count; T.unique = new Set(ev.result.videos.map(v => v.id)).size; T.contract = { requested_limit: ev.result.requested_limit, limit_reached: ev.result.limit_reached, has_more: ev.result.has_more, mode: ev.result.mode, source_type: ev.result.source_type }; T.firstUrl = ev.result.videos[0]?.url; T.allShortsUrls = ev.result.videos.every(v => /\/shorts\//.test(v.url)); }
      else if (ev.type === 'error') T.errorEvent = { at: now(), name: ev.name, message: ev.message };
    };
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (T.firstByteMs === null) T.firstByteMs = now(); T.totalBytes += value.length; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() ?? ''; for (const l of lines) handle(l); }
    if (buf.trim()) handle(buf);
  } catch (e) { T.clientError = `${e.name}: ${e.message}`; }
  clearTimeout(guard); T.endMs = now(); return T;
}

try {
  let up = false; for (let i = 0; i < 400 && !up; i++) { try { up = (await fetch(`${BASE}/api/ping`)).ok; } catch { /* boot */ } if (!up) await sleep(400); } R.serverBooted = up; if (!up) throw new Error('server did not boot: ' + log.slice(-500));
  R.health = await fetch(`${BASE}/api/health`).then(r => r.json()).then(h => ({ ollama_connected: h.ollama_connected })).catch(e => ({ error: e.message }));
  killYtdlp(); await sleep(300);

  for (const lim of [25, 50, 100]) { R.tests[`limited_${lim}`] = await discover({ mode: 'limited', limit: lim }); console.log('limited', lim, JSON.stringify({ first: R.tests[`limited_${lim}`].firstProgressMs, done: R.tests[`limited_${lim}`].doneMs, n: R.tests[`limited_${lim}`].returned, doneBytes: R.tests[`limited_${lim}`].doneLineBytes })); }

  // client disconnect during the silent crawl of ALL (what the UI cancel / page reload does)
  { const procBefore = ytdlpCount(); const p = discover({ mode: 'all' }, { abortAfterMs: 12_000 }); await sleep(10_000); const during = ytdlpCount(); const T = await p; const samples = []; for (let i = 0; i < 12; i++) { await sleep(10_000); samples.push({ tSinceAbortS: (i + 1) * 10, ytdlpProcesses: ytdlpCount() }); if (samples.at(-1).ytdlpProcesses === 0) break; }
    R.tests.all_client_disconnect_at_12s = { processesBefore: procBefore, processesDuring: during, client: { aborted: T.aborted, clientError: T.clientError, firstProgressMs: T.firstProgressMs }, processesAfterDisconnect: samples, orphanAfter120s: samples.at(-1).ytdlpProcesses }; console.log('disconnect', JSON.stringify(R.tests.all_client_disconnect_at_12s)); killYtdlp(); await sleep(1000); }

  // full ALL run through the server, server RSS sampled
  if (process.argv[3] !== 'skipall') { let peak = 0; const sm = setInterval(() => { const m = rssMb(srv.pid); if (m) peak = Math.max(peak, m); }, 3000); const T = await discover({ mode: 'all' }); clearInterval(sm); T.serverRssPeakMb = peak; R.tests.all_full = T; console.log('all', JSON.stringify(T)); await sleep(3000); R.tests.all_full.ytdlpProcessesAfter = ytdlpCount(); }
  R.serverLogTail = log.split('\n').filter(l => /PLAYLIST|error|Error/.test(l)).slice(-8).map(l => l.slice(0, 300));
} catch (e) { R.fatal = e.stack; } finally { killYtdlp(); await kill(srv); fs.writeFileSync(OUT, JSON.stringify(R, null, 1)); console.log('written', OUT); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* locked */ } process.exit(0); }
