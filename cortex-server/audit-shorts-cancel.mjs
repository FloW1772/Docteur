// AUDIT ONLY — what happens to the yt-dlp process tree when Docteur's discovery is cancelled (AbortSignal) or killed by its inactivity watchdog.
// Real yt-dlp, real public channel, metadata only. Counts yt-dlp.exe processes (bootloader + worker) before / right after / later.
// Usage: node audit-shorts-cancel.mjs <url>
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { getPlaylistInfo } from './src/lib/ytdlp.js';

const URL_ = process.argv[2] ?? 'https://www.youtube.com/@Ines-n9m/shorts'; const OUT = path.resolve('..', 'reports', 'audit-shorts-cancel-results.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const procs = () => { const r = spawnSync('powershell', ['-NoProfile', '-Command', "Get-Process -Name yt-dlp -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"], { encoding: 'utf8', windowsHide: true }); return String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map(Number); };
const killAll = () => { for (const pid of procs()) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } };
const R = { generatedAt: new Date().toISOString(), url: URL_, note: 'any leftover yt-dlp processes are killed at the end of each scenario (audit cleanup)', scenarios: {} };
killAll(); await sleep(500); R.baselineProcesses = procs().length;

// A — AbortSignal (what the UI "cancel" and an HTTP disconnect do): abort ~8 s into an ALL discovery
{
  const ctrl = new AbortController(); const t0 = Date.now(); let pid = null;
  const spawnImpl = (b, a, o) => { const p = spawn(b, a, o); pid = p.pid; return p; };
  const p = getPlaylistInfo(URL_, { mode: 'all', signal: ctrl.signal, spawnImpl }).then(() => 'resolved', e => `${e.name}@${Date.now() - t0}ms`);
  await sleep(8000); const before = procs(); ctrl.abort(); const abortAt = Date.now() - t0;
  const settled = await Promise.race([p, sleep(20000).then(() => 'STILL_PENDING_20s_AFTER_ABORT')]);
  const after1 = procs(); await sleep(6000); const after2 = procs();
  R.scenarios.A_abortSignal_during_ALL = { abortAtMs: abortAt, processesBeforeAbort: before.length, settled, promiseSettledAfterMs: typeof settled === 'string' ? settled : null, processesRightAfterSettle: after1.length, processesSixSecondsLater: after2.length, parentPid: pid, orphanSurvivors: after2.filter(x => x !== null).length };
  killAll(); await sleep(800);
}

// B — inactivity watchdog forced to 6 s (yt-dlp ALL is silent for 39–80 s while it crawls all pages): what does the kill do?
{
  const t0 = Date.now(); let pid = null; let closedAt = null;
  const spawnImpl = (b, a, o) => { const p = spawn(b, a, o); pid = p.pid; p.on('close', () => { closedAt = Date.now() - t0; }); return p; };
  let progress = 0;
  const p = getPlaylistInfo(URL_, { mode: 'all', inactivityTimeoutMs: 6000, spawnImpl, onProgress: () => { progress++; } }).then(() => 'resolved', e => `${e.name}@${Date.now() - t0}ms`);
  await sleep(9000); const at9 = procs();
  const settled = await Promise.race([p, sleep(150000).then(() => 'STILL_PENDING_150s')]);
  const after = procs(); await sleep(4000); const later = procs();
  R.scenarios.B_watchdog_kill_ALL = { watchdogMs: 6000, processesAt9s: at9.length, settled, parentClosedAtMs: closedAt, progressEventsBeforeSettle: progress, processesRightAfterSettle: after.length, processesFourSecondsLater: later.length };
  killAll(); await sleep(800);
}

// C — the same abort on a LIMITED discovery (25): finishes by itself in ~2 s, nothing to orphan
{
  const t0 = Date.now(); const info = await getPlaylistInfo(URL_, { mode: 'limited', limit: 25 }); await sleep(1500);
  R.scenarios.C_limited_25_clean_exit = { returned: info.video_count, durationMs: Date.now() - t0, processesAfter: procs().length };
}
fs.writeFileSync(OUT, JSON.stringify(R, null, 1)); console.log(JSON.stringify(R.scenarios, null, 1)); killAll(); process.exit(0);
