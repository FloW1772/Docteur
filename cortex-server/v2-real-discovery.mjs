// CERTIFICATION HARNESS — YouTube Smart Discovery V2 against REAL public channels (yt-dlp metadata only, no media, no cookies/login).
// For one input it (1) runs yt-dlp DIRECTLY once per source tab (counts, unique ids, time) and (2) runs Docteur's discoverYouTube,
// recording the event timeline, heartbeat gaps, Node RSS/CPU, and comparing every tab with the direct count.
// Usage: node v2-real-discovery.mjs <input> <label> [--youtube-context] [--skip-direct]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { YTDLP_BIN } from './src/lib/ytdlp.js';
import { classifyDiscoveryInput, discoverYouTube } from './src/lib/youtube-discovery.js';

const [input, label = 'run'] = process.argv.slice(2);
const flags = new Set(process.argv.slice(4));
const OUT = path.resolve('..', 'reports', `v2-real-${label}.json`);
const classified = classifyDiscoveryInput(input, { allowBareHandle: flags.has('--youtube-context') });
if (!classified.ok) { console.error('invalid input', classified); process.exit(2); }
const R = { generatedAt: new Date().toISOString(), input, label, mode: classified.mode, sources: classified.sources.map(s => s.url), direct: {}, docteur: null };

async function direct(source) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const proc = spawn(YTDLP_BIN, [source.url, '--flat-playlist', '--dump-json', '--no-warnings', '--no-playlist-reverse'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = ''; let lines = 0; let firstLineMs = null; const ids = []; let stderr = '';
    proc.stdout.on('data', d => { buf += d; const parts = buf.split(/\r?\n/); buf = parts.pop() ?? ''; for (const l of parts) { if (!l.trim()) continue; lines++; if (firstLineMs === null) firstLineMs = Date.now() - t0; try { ids.push(JSON.parse(l).id); } catch { /* skip */ } } });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => { if (buf.trim()) { lines++; try { ids.push(JSON.parse(buf).id); } catch { /* skip */ } } resolve({ exit: code, lines, unique: new Set(ids).size, firstLineMs, durationMs: Date.now() - t0, stderr: stderr.slice(0, 200), ids }); });
  });
}

if (!flags.has('--skip-direct')) {
  for (const source of classified.sources) { const d = await direct(source); R.direct[source.tab] = { ...d, ids: undefined }; R.direct[`_ids_${source.tab}`] = d.ids; console.log('direct', source.tab, d.lines, d.unique, d.durationMs, 'ms exit', d.exit); }
}

const t0 = performance.now(); const now = () => Math.round(performance.now() - t0);
const tl = { first: {}, marks: {}, events: [] }; let peakRss = 0; const cpu0 = process.cpuUsage();
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);
let lastBytes = now(); let maxGap = 0; const gapSamples = [];
const spawnImpl = (bin, args, opts) => {
  const p = spawn(bin, args, opts); lastBytes = now();
  const touch = () => { const t = now(); maxGap = Math.max(maxGap, t - lastBytes); lastBytes = t; };
  p.stdout.on('data', touch); p.stderr.on('data', touch); return p;
};
let total = 0;
const events = [];
const summary = await discoverYouTube(input, {
  allowBareHandle: flags.has('--youtube-context'), spawnImpl,
  onEvent: e => {
    const at = now();
    if (e.type === 'items_batch') { total += e.items.length; tl.first.items ??= at; tl.first[`items_${e.tab}`] ??= at; for (const m of [100, 500, 1000, 2000, 2500]) if (total >= m) tl.marks[m] ??= at; }
    if (e.type === 'progress') { tl.first.progress ??= at; }
    if (e.type === 'phase_start' || e.type === 'phase_done' || e.type === 'done' || e.type === 'error' || e.type === 'cancelled' || e.type === 'mode' || e.type === 'start') {
      tl.events.push({ at, type: e.type, tab: e.tab, count: e.count, total: e.total, pages: e.pages, available: e.available, code: e.code, message: e.message });
    }
    events.push(e.type);
  },
});
clearInterval(sampler);
const items = summary.items ?? [];
R.docteur = {
  status: summary.status, mode: summary.mode, total: summary.total, counts: summary.counts, duplicates: summary.duplicates, durationMs: summary.durationMs,
  channel: summary.channel, firstProgressMs: tl.first.progress ?? null, firstItemsMs: tl.first.items ?? null, firstItemsByTab: Object.fromEntries(Object.entries(tl.first).filter(([k]) => k.startsWith('items_'))),
  marks: tl.marks, timeline: tl.events, maxGapBetweenYtDlpBytesMs: maxGap, nodeRssPeakMb: +(peakRss / 1048576).toFixed(1), nodeCpuMs: Math.round((process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000),
  eventCounts: events.reduce((m, t) => { m[t] = (m[t] ?? 0) + 1; return m; }, {}),
  mediaTypes: items.reduce((m, i) => { m[i.mediaType] = (m[i.mediaType] ?? 0) + 1; return m; }, {}),
  sourceTabs: items.reduce((m, i) => { m[i.sourceTab] = (m[i.sourceTab] ?? 0) + 1; return m; }, {}),
  uniqueIds: new Set(items.map(i => i.id)).size,
  shortsUrlsOk: items.filter(i => i.mediaType === 'SHORT').every(i => /\/shorts\//.test(i.url)),
  videoUrlsOk: items.filter(i => i.mediaType !== 'SHORT').every(i => /watch\?v=/.test(i.url)),
  sample: items.slice(0, 2).map(i => ({ ...i, title: '(omitted)' })),
};
// parity per tab + union
const directIds = {};
for (const s of classified.sources) directIds[s.tab] = R.direct[`_ids_${s.tab}`] ?? null;
R.parity = {};
for (const s of classified.sources) {
  const d = R.direct[s.tab]; if (!d) continue;
  const mine = items.filter(i => (i.sourceTabs ?? [i.sourceTab]).includes(s.tab)).length;
  R.parity[s.tab] = { direct: d.unique, docteur: mine, diff: mine - d.unique, pass: mine === d.unique };
}
if (Object.keys(directIds).length && Object.values(directIds).every(Boolean)) {
  const union = new Set(Object.values(directIds).flat());
  const mine = new Set(items.map(i => i.id));
  R.parity._union = { direct: union.size, docteur: mine.size, diff: mine.size - union.size, pass: mine.size === union.size && [...union].every(id => mine.has(id)) };
}
for (const k of Object.keys(R.direct)) if (k.startsWith('_ids_')) delete R.direct[k];
fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
console.log(JSON.stringify({ status: R.docteur.status, total: R.docteur.total, counts: R.docteur.counts, ms: R.docteur.durationMs, firstProgress: R.docteur.firstProgressMs, firstItems: R.docteur.firstItemsMs, maxGap: maxGap, rss: R.docteur.nodeRssPeakMb, parity: R.parity }));
process.exit(summary.status === 'done' ? 0 : 1);
