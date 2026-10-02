// AUDIT ONLY — Docteur's own discovery (lib/ytdlp.js getPlaylistInfo) on a large public Shorts channel, module-level (no HTTP, no UI).
// Wraps spawn to record the exact argv / pid / exit, timestamps every onProgress(count) callback, samples the Node process RSS / heap and CPU,
// and compares the result with the direct yt-dlp listing (audit-shorts-direct.mjs) for parity. Usage: node audit-shorts-docteur.mjs <url> [modes]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getPlaylistInfo, classifyYouTubeUrl, normalizeChannelVideosUrl } from './src/lib/ytdlp.js';

const URL_ = process.argv[2] ?? 'https://www.youtube.com/@Ines-n9m/shorts'; const MODES = (process.argv[3] ?? '25,50,100,all').split(',');
const OUT = path.resolve('..', 'reports', 'audit-shorts-docteur-results.json'); const DIRECT = path.resolve('..', 'reports', 'audit-shorts-direct-results.json');
const MARKS = [1, 25, 50, 100, 250, 500, 1000, 1500, 2000, 2500];
const results = { generatedAt: new Date().toISOString(), url: URL_, urlHandling: { classified: classifyYouTubeUrl(URL_), normalized: normalizeChannelVideosUrl(URL_), shortsTabPreserved: normalizeChannelVideosUrl(URL_).endsWith('/shorts') }, runs: {} };

async function run(mode) {
  const t0 = performance.now(); const now = () => Math.round(performance.now() - t0); const rec = { mode, spawn: null, marks: {}, progressEvents: 0, events: [] };
  const spawnImpl = (bin, args, opts) => { const p = spawn(bin, args, opts); rec.spawn = { atMs: now(), pid: p.pid, argvWithoutUrl: args.slice(1), urlArg: args[0] }; p.on('close', (code, sig) => { rec.spawn.exit = code; rec.spawn.signal = sig; rec.spawn.closedAtMs = now(); }); return p; };
  let peakRss = 0; let peakHeap = 0; const cpu0 = process.cpuUsage(); const sampler = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); }, 100);
  global.gc?.(); const base = process.memoryUsage().rss;
  let info; let error = null;
  try {
    info = await getPlaylistInfo(URL_, { mode: mode === 'all' ? 'all' : 'limited', ...(mode === 'all' ? {} : { limit: Number(mode) }), spawnImpl, onProgress: ({ count }) => { rec.progressEvents++; if (MARKS.includes(count)) rec.marks[count] = now(); if (count === 1) rec.firstResultMs = now(); } });
  } catch (e) { error = { name: e.name, message: e.message }; }
  clearInterval(sampler); const cpu = process.cpuUsage(cpu0);
  rec.doneMs = now(); rec.marks.done = rec.doneMs; rec.error = error;
  if (info) {
    const json = JSON.stringify(info); const ids = info.videos.map(v => v.id);
    Object.assign(rec, { returned_count: info.video_count, requested_limit: info.requested_limit, limit_reached: info.limit_reached, has_more: info.has_more, contractMode: info.mode, source_type: info.source_type, title: info.title, uploader: info.uploader, playlistId: info.playlistId,
      uniqueIds: new Set(ids).size, finalPayloadBytes: json.length, bytesPerVideo: Math.round(json.length / Math.max(1, info.videos.length)), videoFields: Object.keys(info.videos[0] ?? {}), firstVideo: { ...info.videos[0], title: '(omitted)' }, ids });
  }
  Object.assign(rec, { nodeRssPeakMb: +(peakRss / 1048576).toFixed(1), nodeRssBaseMb: +(base / 1048576).toFixed(1), nodeHeapPeakMb: +(peakHeap / 1048576).toFixed(1), nodeCpuUserMs: Math.round(cpu.user / 1000), nodeCpuSystemMs: Math.round(cpu.system / 1000) });
  return rec;
}

const direct = fs.existsSync(DIRECT) ? JSON.parse(fs.readFileSync(DIRECT, 'utf8')) : null;
for (const m of MODES) {
  console.log('running', m); const r = await run(m); const d = direct?.runs?.[m];
  if (d) Object.assign(r, { directLines: d.lines, directUnique: d.uniqueIds, parity: r.returned_count === d.uniqueIds, directFirstLineMs: d.firstLineMs, directDurationMs: d.durationMs });
  results.runs[m] = { ...r, ids: undefined, idsSample: r.ids?.slice(0, 3) }; r.ids && (results.runs[m].idsFingerprint = r.ids.slice(0, 10).join(','));
  console.log(JSON.stringify({ mode: m, returned: r.returned_count, limit_reached: r.limit_reached, has_more: r.has_more, first: r.firstResultMs, marks: r.marks, doneMs: r.doneMs, payloadKB: Math.round((r.finalPayloadBytes ?? 0) / 1024), rssPeak: r.nodeRssPeakMb, cpuMs: r.nodeCpuUserMs, parity: r.parity, error: r.error }));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
}
console.log('written', OUT); process.exit(0);
