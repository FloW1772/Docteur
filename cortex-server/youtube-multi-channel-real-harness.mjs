// REAL-NETWORK HARNESS — YouTube Multi-Channel V1 (metadata only: yt-dlp --flat-playlist; no media, no cookies, no login).
// Runs the real queue + real discoverYouTube + real yt-dlp through the EXISTING protections, exactly like the server does:
//   • Root Policy: the real signed policy is verified (read-only); no dataDir → no runtime state written anywhere;
//   • Media Egress: startMediaEgress() → every yt-dlp gets --proxy (Web Egress Guard); DOCTEUR_TEST_MODE must NOT be set;
//   • actor context: the batch is created inside runWithActor(USER), as the HTTP middleware does for every request.
// Tiny public listings only; the one large channel is cancelled after a few seconds (proves the real process-tree kill).
// Usage: node youtube-multi-channel-real-harness.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRootPolicyStatus, initRootPolicy, runWithActor } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';
import { startMediaEgress, stopMediaEgress } from './src/lib/media-egress.js';
import { createChannelDiscoveryQueue } from './src/lib/youtube-channel-queue.js';

if (process.env.DOCTEUR_TEST_MODE === '1') { console.error('refused: DOCTEUR_TEST_MODE=1 would skip the media egress proxy'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ytDlpProcesses = () => {
  try { return execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', 'IMAGENAME eq yt-dlp.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(l => l.includes('yt-dlp.exe')).length; } catch { return -1; }
};

const LINES = [
  'https://www.youtube.com/@jawed/videos',          // 1 tiny public listing
  'https://www.youtube.com/@Google/videos',          // 2 large listing → cancelled while running
  'https://www.youtube.com/@docteur-no-such-channel-7f3a9c',  // 3 does not exist → FAILED for this line only
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',     // 4 a video, not a channel → INVALID
  'youtube.com/@Jawed/videos/',                      // 5 duplicate of line 1 (case, scheme, slash)
  'https://www.youtube.com/@jawed',                  // 6 root URL: videos + shorts + streams
];

initRootPolicy({ policyDir: path.join(HERE, 'policy'), dataDir: undefined, trustAnchors: TRUST_ANCHORS });
const proxy = await startMediaEgress();
const before = ytDlpProcesses();
const queue = createChannelDiscoveryQueue({ concurrency: 2 });
const t0 = Date.now();
let peakSlots = 0; let peakOs = 0;
const sampler = setInterval(() => { peakSlots = Math.max(peakSlots, queue.runningCount()); peakOs = Math.max(peakOs, ytDlpProcesses()); }, 250);

let report;
try {
  const created = runWithActor({ kind: 'USER', userInitiated: true, via: 'http' }, () => queue.createBatch(LINES.join('\n')));
  const id = created.batchId;
  console.log('created', created.jobs.map(j => `${j.index + 1}:${j.status}`).join(' '));
  let cancelledAt = null;
  while (true) {
    const snap = queue.getBatch(id);
    const big = snap.jobs[1];
    if (!cancelledAt && big.status === 'RUNNING' && Date.now() - big.startedAt > 5_000) {
      runWithActor({ kind: 'USER', userInitiated: true, via: 'http' }, () => queue.cancelJob(id, big.id));
      cancelledAt = Date.now();
      console.log(`cancelled line 2 after ${Math.round((cancelledAt - big.startedAt) / 1000)} s (items found so far: ${big.itemsFound})`);
    }
    if (!snap.summary.active && queue.runningCount() === 0) break;
    if (Date.now() - t0 > 5 * 60_000) throw new Error('harness timeout (5 min)');
    await sleep(500);
  }
  await sleep(1500); // let the OS reap the killed trees before counting
  const end = queue.getBatch(id);
  report = {
    rootPolicy: (({ state, integrity, version, sha256 }) => ({ state, integrity, version, sha256 }))(getRootPolicyStatus()), mediaEgressProxy: Boolean(proxy?.url),
    durationS: Math.round((Date.now() - t0) / 1000),
    concurrency: queue.concurrency, peakSlots, peakOsYtDlpProcesses: peakOs,
    ytDlpProcesses: { before, after: ytDlpProcesses() },
    summary: end.summary,
    jobs: end.jobs.map(j => ({ line: j.index + 1, status: j.status, name: j.channelName, items: j.itemsFound, phases: j.phases.map(p => `${p.tab}:${p.status}:${p.count}`).join(' '), error: j.error?.code ?? null, message: j.status === 'COMPLETED' ? null : j.message })),
    lineItems: Object.fromEntries(end.jobs.filter(j => j.status === 'COMPLETED').map(j => [j.index + 1, queue.getJobResult(id, j.id).items.map(i => i.title).slice(0, 3)])),
  };
} finally {
  clearInterval(sampler);
  await queue.close();
  await stopMediaEgress();
}
console.log(JSON.stringify(report, null, 1));
