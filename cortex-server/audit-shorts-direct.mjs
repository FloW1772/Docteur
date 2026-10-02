// AUDIT ONLY — direct yt-dlp on a large public Shorts channel, with EXACTLY the argv Docteur uses (lib/ytdlp.js getPlaylistInfo):
//   <url> --flat-playlist --dump-json --no-warnings --no-playlist-reverse [--playlist-end N]
// Measures: first stdout byte, first JSON line, time to the 1st / 25th / 50th / 100th / 500th / 1000th / 2000th / last line, exit, stdout bytes,
// stderr, unique video ids, duplicates, yt-dlp process tree working-set / CPU peaks (sampled from the OS), and the order of ids.
// Public content only; no cookies, no login. Usage: node audit-shorts-direct.mjs <url> [modes=25,50,100,all]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { YTDLP_BIN } from './src/lib/ytdlp.js';

const URL_ = process.argv[2] ?? 'https://www.youtube.com/@Ines-n9m/shorts';
const MODES = (process.argv[3] ?? '25,50,100,all').split(',');
const OUT = path.resolve('..', 'reports', 'audit-shorts-direct-results.json');
const MARKS = [1, 25, 50, 100, 250, 500, 1000, 1500, 2000, 2500];

function sampleProcs() { // working set (MB) + cumulative CPU seconds of every yt-dlp process
  const r = spawnSync('powershell', ['-NoProfile', '-Command', "Get-Process -Name yt-dlp -ErrorAction SilentlyContinue | ForEach-Object { '{0},{1},{2}' -f $_.Id, [math]::Round($_.WorkingSet64/1MB,1), [math]::Round($_.CPU,2) }"], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map(l => { const [pid, mb, cpu] = l.split(','); return { pid: Number(pid), mb: Number(mb), cpu: Number(cpu) }; });
}

async function run(mode) {
  const limit = mode === 'all' ? null : Number(mode);
  const args = [URL_, '--flat-playlist', '--dump-json', '--no-warnings', '--no-playlist-reverse', ...(limit ? ['--playlist-end', String(limit)] : [])];
  const t0 = performance.now(); const now = () => Math.round(performance.now() - t0);
  const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { mode, argvWithoutUrl: args.slice(1), pid: proc.pid, spawnedAtMs: 0, firstByteMs: null, firstLineMs: null, marks: {}, lines: 0, bytes: 0, stderr: '', exit: null, signal: null, durationMs: null, ids: [], fieldsOfFirstEntry: null, maxLineBytes: 0, chunkCount: 0, maxChunkBytes: 0 };
  let buf = ''; let peakMb = 0; let peakCpuDelta = 0; let procs = 0; const samples = [];
  const sampler = setInterval(() => { const s = sampleProcs(); const mb = s.reduce((a, x) => a + x.mb, 0); const cpu = s.reduce((a, x) => a + x.cpu, 0); peakMb = Math.max(peakMb, mb); procs = Math.max(procs, s.length); samples.push({ t: now(), mb, cpuTotal: cpu, n: s.length }); }, 2000);
  proc.stdout.on('data', d => {
    r.chunkCount++; r.maxChunkBytes = Math.max(r.maxChunkBytes, d.length); r.bytes += d.length; if (r.firstByteMs === null) r.firstByteMs = now();
    buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? '';
    for (const line of lines) { if (!line.trim()) continue; r.lines++; r.maxLineBytes = Math.max(r.maxLineBytes, line.length); if (r.firstLineMs === null) { r.firstLineMs = now(); try { r.fieldsOfFirstEntry = Object.keys(JSON.parse(line)); } catch { /* ignore */ } } try { r.ids.push(JSON.parse(line).id); } catch { /* ignore */ } if (MARKS.includes(r.lines)) r.marks[r.lines] = now(); }
  });
  proc.stderr.on('data', d => { r.stderr += d.toString(); });
  await new Promise(res => proc.on('close', (code, sig) => { r.exit = code; r.signal = sig; res(); }));
  clearInterval(sampler); r.durationMs = now(); r.marks.last = r.durationMs;
  if (buf.trim()) { r.lines++; try { r.ids.push(JSON.parse(buf).id); } catch { /* ignore */ } }
  const uniq = new Set(r.ids);
  samples.sort((a, b) => a.t - b.t); const cpuSpan = samples.length > 1 ? samples.at(-1).cpuTotal - samples[0].cpuTotal : 0; const wall = samples.length > 1 ? (samples.at(-1).t - samples[0].t) / 1000 : 0;
  Object.assign(r, { rawEntries: r.ids.length, uniqueIds: uniq.size, duplicates: r.ids.length - uniq.size, ytdlpPeakWorkingSetMb: +peakMb.toFixed(1), ytdlpProcessesSeen: procs, ytdlpAvgCpuCores: wall ? +(cpuSpan / wall).toFixed(2) : null, stderr: r.stderr.slice(0, 600), idsHead: r.ids.slice(0, 5), idsTail: r.ids.slice(-3), samples: samples.length });
  r.ids = undefined; r.orderFingerprint = [...uniq].slice(0, 25).join(','); return { r, uniq: [...uniq] };
}

const results = { generatedAt: new Date().toISOString(), url: URL_, ytdlp: YTDLP_BIN, runs: {} };
const idsByMode = {};
for (const m of MODES) { console.log('running', m); const { r, uniq } = await run(m); results.runs[m] = r; idsByMode[m] = uniq; console.log(JSON.stringify({ mode: m, lines: r.lines, unique: r.uniqueIds, firstLineMs: r.firstLineMs, marks: r.marks, durationMs: r.durationMs, exit: r.exit, peakMb: r.ytdlpPeakWorkingSetMb })); fs.writeFileSync(OUT, JSON.stringify(results, null, 1)); }
// prefix consistency: the limited runs must be prefixes of the ALL listing (same order)
if (idsByMode.all) for (const m of MODES.filter(x => x !== 'all')) results.runs[m].prefixOfAll = idsByMode[m].every((id, i) => id === idsByMode.all[i]);
fs.writeFileSync(OUT, JSON.stringify(results, null, 1)); console.log('written', OUT); process.exit(0);
