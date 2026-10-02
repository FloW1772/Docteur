// AUDIT ONLY — REAL cortex-server (isolated temp SQLite + LanceDB, port 3944), real yt-dlp (metadata only, --flat-playlist),
// real Ollama embeddings. Measures what the SERVER does when playlists / index calls arrive concurrently:
//   • parallel discovery: how many yt-dlp processes run at once, are results isolated;
//   • parallel /api/index: does the server (or Ollama) serialise? errors? first-insert LanceDB race? same-id double write?
//   • in-memory job registry across a restart.
// Nothing is downloaded (no media, no audio). Usage: node audit-playlist-queue-server.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from '@lancedb/lancedb';
import Database from 'better-sqlite3';

const PORT = 3944; const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-queue-'));
const SQLITE = path.join(TMP, 'a.sqlite'); const LANCE = path.join(TMP, 'a.lance');
const OUT = path.resolve('..', 'reports', 'audit-playlist-queue-server-results.json');
const R = { generatedAt: new Date().toISOString(), port: PORT, notes: 'metadata-only discovery; no media downloaded', tests: {} };
const PLAYLISTS = { A: 'https://www.youtube.com/playlist?list=PLNaAc9o-jKVBmldLkcbdGexi9eqjjALwf', B: 'https://www.youtube.com/playlist?list=PLtw1Zojx2cykvBql22EwoQIH5-JgbRbod' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const now = () => Date.now() - t0;

function boot() {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), SQLITE_PATH: SQLITE, LANCEDB_PATH: LANCE }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  return { child, log: () => log };
}
async function waitUp(ms = 60_000) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(`${BASE}/api/ping`)).ok) return true; } catch { /* not yet */ } await sleep(400); } return false; }
const kill = (child) => new Promise(res => { child.once('exit', () => res()); try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } setTimeout(res, 5000); });
const ytdlpCount = () => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH'], { encoding: 'utf8' }).split('\n').filter(l => /yt-dlp\.exe/i.test(l)).length; } catch { return 0; } };

async function discover(url, limit = 25) {
  const start = now(); const res = await fetch(`${BASE}/api/capture/playlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, mode: 'limited', limit }) });
  const text = await res.text(); const lines = text.trim().split('\n').map(l => JSON.parse(l)); const done = lines.find(l => l.type === 'done'); const err = lines.find(l => l.type === 'error');
  return { start, end: now(), status: res.status, ok: !!done, error: err?.message ?? null, title: done?.result.title, playlistId: done?.result.playlistId, videos: done?.result.videos ?? [] };
}
async function index(id, title, content) {
  const start = now(); try {
    const res = await fetch(`${BASE}/api/index`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, kind: 'video', title, content, metadata: {} }) });
    const body = await res.json().catch(() => ({})); return { id, start, end: now(), status: res.status, ok: res.ok, error: res.ok ? null : String(body.error ?? '').slice(0, 160), embedding_ms: body.embedding_ms ?? null, lancedb_ms: body.lancedb_ms ?? null };
  } catch (e) { return { id, start, end: now(), status: 0, ok: false, error: e.message }; }
}
const lanceRows = async () => { try { const db = await connect(LANCE); const t = await db.openTable('neurons'); const rows = await t.query().select(['id']).toArray(); return rows.map(r => r.id); } catch { return []; } };
const overlap = (rs) => { let max = 0; for (const a of rs) { const c = rs.filter(b => b.start < a.end && a.start < b.end).length; max = Math.max(max, c); } return max; };

let srv;
try {
  srv = boot(); if (!(await waitUp())) throw new Error(`server did not boot: ${srv.log().slice(-400)}`);
  await fetch(`${BASE}/api/health`).then(r => r.json()).then(h => { R.health = { ollama_connected: h.ollama_connected, embedding_model: h.embedding_model }; });

  // ── 1. concurrent discovery (two public playlists, metadata only) ────────────────────────
  let maxYtdlp = 0; let stopPoll = false; const poll = (async () => { while (!stopPoll) { maxYtdlp = Math.max(maxYtdlp, ytdlpCount()); await sleep(200); } })();
  const [dA, dB] = await Promise.all([discover(PLAYLISTS.A), discover(PLAYLISTS.B)]); stopPoll = true; await poll;
  R.tests.concurrent_discovery = { A: { ...dA, videos: dA.videos.length }, B: { ...dB, videos: dB.videos.length }, parallel: overlap([dA, dB]) === 2, maxSimultaneousYtDlpProcesses: maxYtdlp, resultsIsolated: dA.playlistId !== dB.playlistId && dA.ok && dB.ok };

  // ── 2. abort isolation: abort A's HTTP request while B runs ──────────────────────────────
  const ctrl = new AbortController(); const abortedStart = now();
  const pA = fetch(`${BASE}/api/capture/playlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: PLAYLISTS.A, mode: 'limited', limit: 25 }), signal: ctrl.signal }).then(r => r.text()).catch(e => `ABORT:${e.name}`);
  const pB = discover(PLAYLISTS.B); await sleep(400); ctrl.abort(); const [ra, rb] = await Promise.all([pA, pB]);
  R.tests.abort_isolation = { aborted: String(ra).startsWith('ABORT'), bCompleted: rb.ok, bVideos: rb.videos.length, elapsedMs: now() - abortedStart };

  // ── 3. concurrent /api/index on a FRESH LanceDB (first-insert race) then on the existing table ──────────
  const vids = dA.videos.slice(0, 8); const T = (v) => v.title || 'Sans titre'; const mk = (v, tag) => index(`aud-${tag}-${v.id}`, T(v), `${T(v)}\n\n${v.url}`);
  const seq0 = []; for (const v of vids.slice(0, 2)) seq0.push(await index(`aud-warm-${v.id}`, T(v), `${T(v)}\n${v.url}`)); // warm Ollama (model load) — also creates the table sequentially
  const seqStart = now(); const seq = []; for (const v of vids) seq.push(await mk(v, 'seq')); const seqMs = now() - seqStart;
  const parStart = now(); const par = await Promise.all(vids.map(v => mk(v, 'par'))); const parMs = now() - parStart;
  R.tests.index_serial_vs_parallel = { n: vids.length, sequentialTotalMs: seqMs, parallelTotalMs: parMs, parallelRequestsOverlapping: overlap(par), parallelErrors: par.filter(x => !x.ok).map(x => x.error), perRequestMs: { sequential: seq.map(x => x.end - x.start), parallel: par.map(x => x.end - x.start) }, embeddingMs: { sequential: seq.map(x => x.embedding_ms), parallel: par.map(x => x.embedding_ms) } };
  const ids1 = await lanceRows(); R.tests.index_serial_vs_parallel.lancedbRowsAfter = ids1.length; R.tests.index_serial_vs_parallel.expectedRows = 2 + vids.length * 2;

  // ── 4. same neuron id written concurrently (same video in two playlists) ────────────────────────
  const dupV = vids[0]; const dup = await Promise.all([index('aud-dup-1', T(dupV), `${T(dupV)} A`), index('aud-dup-1', T(dupV), `${T(dupV)} B`), index('aud-dup-1', T(dupV), `${T(dupV)} C`)]);
  const ids2 = await lanceRows(); R.tests.same_id_concurrent = { statuses: dup.map(x => x.status), errors: dup.filter(x => !x.ok).map(x => x.error), rowsWithThatId: ids2.filter(i => i === 'aud-dup-1').length };

  // ── 5. first-insert race on a FRESH database (server restart with an empty LanceDB dir) ────────────────
  await kill(srv.child); fs.rmSync(LANCE, { recursive: true, force: true }); srv = boot(); if (!(await waitUp())) throw new Error('reboot failed');
  const fresh = await Promise.all(vids.slice(0, 6).map(v => mk(v, 'fresh')));
  const ids3 = await lanceRows();
  R.tests.first_insert_race_fresh_lancedb = { statuses: fresh.map(x => x.status), errors: fresh.filter(x => !x.ok).map(x => x.error), rowsAfter: ids3.length, requested: 6 };

  // ── 6. in-memory job registry across a hard restart ─────────────────────────────────────────────
  const job = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'Import de playlist', total: 10 }) })).json();
  const before = (await (await fetch(`${BASE}/api/jobs`)).json()).jobs.map(j => ({ id: j.id, status: j.status }));
  await kill(srv.child); srv = boot(); await waitUp();
  const after = (await (await fetch(`${BASE}/api/jobs`)).json()).jobs;
  R.tests.job_registry_restart = { registered: job.id, before, afterRestart: after.length, lost: after.length === 0 };
  // a neuron saved to SQLite survives, a LanceDB row survives (persistence of DATA, not of the queue)
  const db = new Database(SQLITE, { readonly: true }); R.tests.job_registry_restart.sqliteTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%job%' OR name LIKE '%queue%'").all().map(r => r.name); db.close();
  R.passed = true;
} catch (e) { R.passed = false; R.error = e.message; console.error('AUDIT SERVER FAILED:', e.message); process.exitCode = 1; } finally {
  if (srv) await kill(srv.child);
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
  console.log(JSON.stringify(R.tests, null, 1)); process.exit(process.exitCode ?? 0);
}
