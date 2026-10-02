// AUDIT ONLY — playlist / indexing queue feasibility. Drives the REAL src/App.tsx in Chromium with a mocked network
// (fixture playlists, controllable latencies, "gates" that hold one request until the test releases it so that timing
// never decides the outcome) and RECORDS what the frontend queue actually does. It asserts the OBSERVED behaviour so the
// audit is reproducible; several observations are FINDINGS (defects), not product passes.
// Nothing in the product is modified. Usage: node scripts/test-audit-playlist-queue-browser.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { deferred, startHarness, openApp, makePlaylists, submitPlaylist, waitBatchModalAndMinimize, installToastSpy, toasts, overlaps, sleep, until } from './audit-queue-lib.mjs';

const OUT = 'reports/audit-playlist-queue-browser-results.json';
const want = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const results = process.env.ONLY && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { generatedAt: new Date().toISOString(), scenarios: {} };
results.error = undefined;
let h; let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const watchdog = setTimeout(() => { console.error('AUDIT deadline'); process.exit(1); }, 3_000_000);
const saver = setInterval(() => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); } catch { /* best effort */ } }, 5000);
const slowVideos = (ms) => (b) => (b.kind === 'video' ? ms : 0);
const jobsSummary = (net) => net.jobs.map(j => ({ id: j.id, op: j.op, total: j.total, start: j.at, end: j.doneAt ?? null }));
const firstSave = (net, prefix) => net.saves.find(s => s.kind === 'video' && s.title.startsWith(prefix))?.at ?? null;
const lastIndexEnd = (net, prefix) => Math.max(0, ...net.index.filter(i => i.title.startsWith(prefix)).map(i => i.end ?? 0));
const distinctVideoPages = (net, url) => new Set(net.saves.filter(s => s.kind === 'video' && s.url === url).map(s => s.id)).size;
const countVideos = (net, p) => new Set(net.saves.filter(s => s.kind === 'video' && s.title.startsWith(`Vidéo ${p}`)).map(s => s.id)).size;
// gate helper: hold the FIRST save matching the predicate until released
const gateOnce = (pred) => { const d = deferred(); let used = false; return { d, gate: (b) => { if (!used && pred(b)) { used = true; return d.promise; } return null; } }; };

async function launchBackToBack(app, ids) {
  const t = [];
  for (const id of ids) {
    await submitPlaylist(app.page, id); t.push({ id, at: app.now() });
    if (id === ids[0]) await waitBatchModalAndMinimize(app.page);
    await sleep(30);
  }
  return t;
}
const allDone = (net, n, ms = 240_000) => until(async () => net.jobs.length >= n && net.jobs.every(j => j.done), ms, 250);

try {
  h = await startHarness();

  // ═════ S1 — A, B, C submitted back-to-back. A's last save is held until B and C are confirmed: A is deterministically running ═════
  if (want('S1')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], PLB: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'], PLC: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] });
    const g = gateOnce(b => b.title === 'Vidéo a6');
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(500), indexMs: 300, discoveryMs: { PLB: 400, PLC: 400 }, gate: g.gate });
    await sleep(1200); await installToastSpy(app.page);
    const sub = await launchBackToBack(app, ['PLA', 'PLB', 'PLC']); const aRunning = app.net.jobs.length === 1 && !app.net.jobs[0].done;
    g.d.release();
    const done = await until(async () => countVideos(app.net, 'c') === 6, 200_000, 250); await sleep(16_000); // let the 3 s debounce + serial index chain drain
    const n = app.net; const J = jobsSummary(n); const T = await toasts(app.page);
    const win = (p) => { const t = n.saves.filter(x => x.kind === 'video' && x.title.startsWith(`Vidéo ${p}`)).map(x => x.at); return { first: Math.min(...t), last: Math.max(...t) }; };
    const wA = win('a'), wB = win('b'), wC = win('c'); const sequential = wA.last <= wB.first && wB.last <= wC.first; const orphanJobs = J.filter(j => j.end == null).map(j => j.id);
    const startOrder = ['a', 'b', 'c'].map(p => firstSave(n, `Vidéo ${p}1`));
    const idxOrder = n.index.filter(i => i.kind === 'video').map(i => i.title[6]).join('');
    const lastIdx = { A: lastIndexEnd(n, 'Vidéo a'), B: lastIndexEnd(n, 'Vidéo b'), C: lastIndexEnd(n, 'Vidéo c') };
    results.scenarios.S1_queue_A_B_C = {
      aStillRunningWhenBAndCWereConfirmed: aRunning, allVideosCreated: done, serverJobRegistry: J, serverJobsRegistered: J.length, orphanRunningJobs: orphanJobs, saveWindows: { A: wA, B: wB, C: wC }, sequentialBySaves: sequential, submittedAt: sub, firstVideoSaveAt: startOrder,
      discovery: n.discovery, discoveryStartedWhileAActive: n.discovery.filter(d => d.id !== 'PLA' && d.start < wA.last + 5000).map(d => d.id),
      indexOrder: idxOrder, indexMaxConcurrency: n.indexMax, lastIndexEndAt: lastIdx,
      jobDoneBeforeItsLastIndex: { A: (J[0]?.end ?? 0) < lastIdx.A, B: (J[1]?.end ?? 0) < lastIdx.B }, queueToasts: T.map(x => x.text), pageErrors: n.errors, external: n.external,
    };
    check(aRunning, 'S1: A was still running when B and C were confirmed');
    check(done && sequential, 'S1: three playlists ran strictly one after the other (windows of video saves do not overlap)');
    check(startOrder[0] < startOrder[1] && startOrder[1] < startOrder[2], 'S1: FIFO A → B → C');
    check(n.indexMax === 1, 'S1: never more than one /api/index in flight (frontend serial index chain)');
    check(idxOrder.replace(/(.)\1+/g, '$1') === 'abc', 'S1: index calls are ordered A → B → C');
    check(T.some(x => /position 2/.test(x.text)) && T.some(x => /position 3/.test(x.text)), 'S1: user is told "Ajouté à la file (position N)"');
    check(n.discovery.filter(d => d.id !== 'PLA').every(d => d.start < wA.last + 5000), 'S1: discovery of B and C was NOT queued (started while A was still running)');
    check(results.scenarios.S1_queue_A_B_C.jobDoneBeforeItsLastIndex.A, 'S1: FINDING — job A reported finished BEFORE its last video was embedded (the 3 s debounce is outside flushIndex)');
    await app.ctx.close();
  }

  // ═════ S2 — the check-then-start window: A's first async step (creating the playlist neuron) is held while B is confirmed ═════
  if (want('S2')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], PLB: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] });
    const g = gateOnce(b => b.kind === 'playlist' && b.title === 'Playlist PLA');
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(500), indexMs: 200, gate: g.gate });
    await sleep(1200); await installToastSpy(app.page);
    await submitPlaylist(app.page, 'PLA'); await sleep(200);
    await submitPlaylist(app.page, 'PLB'); // confirmed while A still awaits its playlist-page save (batchProgress still null)
    const bStartedWhileAHeld = await until(async () => app.net.saves.some(s => s.kind === 'video' && s.title.startsWith('Vidéo b')), 20_000);
    g.d.release(); await allDone(app.net, 1, 120_000); await sleep(9000);
    const n = app.net; const J = jobsSummary(n); const T = await toasts(app.page);
    const seq = n.saves.filter(s => s.kind === 'video').map(s => s.title[6]).join('').replace(/(.)\1+/g, '$1');
    results.scenarios.S2_start_window_race = { bStartedWhileAHeld, jobsRegisteredOnServer: J, videoSaveInterleaving: seq, toasts: T.map(x => x.text), pageErrors: n.errors };
    check(bStartedWhileAHeld, 'S2: B started running immediately although A had already been accepted');
    check(!T.some(x => /Ajouté à la file/.test(x.text)), 'S2: B was NOT queued (no "Ajouté à la file" toast)');
    check(/ab|ba/.test(seq) && seq.length >= 3, `S2: A and B ran IN PARALLEL (interleaved video saves "${seq}")`);
    results.scenarios.S2_start_window_race.orphanRunningJobsOnServer = J.filter(j => j.end == null).map(j => j.id); // intermittent: the two loops share ONE jobIdRef, an entry can stay 'running' forever
    await app.ctx.close();
  }

  // ═════ S3 — cancel A (running) while B and C are queued ═════
  if (want('S3')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], PLB: ['b1', 'b2', 'b3'], PLC: ['c1', 'c2', 'c3'] });
    const g = gateOnce(b => b.title === 'Vidéo a4');
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(300), indexMs: 200, gate: g.gate });
    await sleep(1200); await installToastSpy(app.page);
    await launchBackToBack(app, ['PLA', 'PLB', 'PLC']);
    const pill = app.page.locator('button[title="Voir la progression du traitement"]'); if (await pill.count()) await pill.click();
    await app.page.locator('button:has-text("Annuler après ce lot")').click(); await sleep(300);
    g.d.release();
    const done = await allDone(app.net, 3, 150_000); await sleep(1500);
    const n = app.net; const T = await toasts(app.page);
    results.scenarios.S3_cancel_A_keeps_B_C = { allDone: done, videosCreated: { A: countVideos(n, 'a'), B: countVideos(n, 'b'), C: countVideos(n, 'c') }, jobs: jobsSummary(n), toasts: T.map(x => x.text) };
    check(countVideos(n, 'a') === 4, 'S3: A stopped after the item in flight (a4) — 4 of 8 videos');
    check(countVideos(n, 'b') === 3 && countVideos(n, 'c') === 3, 'S3: cancelling A did NOT cancel B and C (they ran to completion)');
    await app.ctx.close();
  }

  // ═════ S4 — save failure in A (server 500 on one video PUT) while B is queued — LOCAL (PC) mode ═════
  if (want('S4')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'a4'], PLB: ['b1', 'b2', 'b3'] });
    const g = gateOnce(b => b.title === 'Vidéo a1');
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(300), indexMs: 200, saveFail: (b) => b.kind === 'video' && b.title === 'Vidéo a2', gate: g.gate });
    await sleep(1200); await installToastSpy(app.page);
    await submitPlaylist(app.page, 'PLA'); await sleep(300); await waitBatchModalAndMinimize(app.page);
    await submitPlaylist(app.page, 'PLB'); // queued behind A (A is held on its first video)
    g.d.release();
    const bDone = await until(async () => countVideos(app.net, 'b') === 3, 120_000, 250); await sleep(6000);
    const n = app.net; const a2Puts = n.saves.filter(s => s.title === 'Vidéo a2').length;
    results.scenarios.S4_local_save_failure = { aVideosCreated: countVideos(n, 'a'), bVideosCreated: countVideos(n, 'b'), bCompleted: bDone, putAttemptsForFailedVideo: a2Puts, indexedFailedVideo: n.index.some(i => i.title === 'Vidéo a2'), toasts: (await toasts(app.page)).map(x => x.text) };
    check(countVideos(n, 'a') === 4 && bDone, 'S4: in local mode a failed server save does not stop A nor block B (failure isolation holds)');
    check(a2Puts >= 1 && n.index.some(i => i.title === 'Vidéo a2' && i.ok), 'S4: FINDING — a video whose server save failed (kept in IndexedDB only) was STILL embedded into LanceDB: vector row without a SQLite neuron (mixed ownership / partial record)');
    await app.ctx.close();
  }

  // ═════ S4b — same failure in REMOTE (phone/LAN) mode, where the caller requires server acknowledgement ═════
  if (want('S4b')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'a4'], PLB: ['b1', 'b2', 'b3'] });
    const g = gateOnce(b => b.title === 'Vidéo a1');
    const app = await openApp(h, { remote: true, playlists: pls, saveMs: slowVideos(300), indexMs: 200, saveFail: (b) => b.kind === 'video' && b.title === 'Vidéo a2', gate: g.gate });
    await sleep(1200); await installToastSpy(app.page);
    await app.page.evaluate(() => { window.__unhandled = []; window.addEventListener('unhandledrejection', e => window.__unhandled.push(String(e.reason?.message ?? e.reason))); });
    await submitPlaylist(app.page, 'PLA'); await sleep(300); await waitBatchModalAndMinimize(app.page);
    await submitPlaylist(app.page, 'PLB'); g.d.release(); await sleep(30_000);
    const n = app.net; const J = jobsSummary(n); const un = await app.page.evaluate(() => window.__unhandled);
    results.scenarios.S4b_remote_save_failure = { jobs: J, aVideosCreated: countVideos(n, 'a'), bVideosCreated: countVideos(n, 'b'), unhandledRejections: un, toasts: (await toasts(app.page)).map(x => x.text) };
    check(un.some(x => /Serveur 500/.test(x)), 'S4b: the runner threw an unhandled rejection (no try/catch around createPageFromData)');
    check(J[0]?.end == null && countVideos(n, 'b') === 0, "S4b: FINDING — in remote mode one failed save kills job A without cleanup: its progress never clears, the queued B never starts (queue stuck until reload)");
    await app.ctx.close();
  }

  // ═════ S5 — the same video in two playlists (A's LAST item is B's FIRST; B is confirmed while A's x1 save is held) ═════
  if (want('S5')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'x1'], PLB: ['x1', 'b2', 'b3'] });
    const g = gateOnce(b => b.title === 'Vidéo x1');
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(300), indexMs: 200, gate: g.gate });
    await sleep(1200); await installToastSpy(app.page);
    await launchBackToBack(app, ['PLA', 'PLB']); g.d.release();
    await allDone(app.net, 2, 150_000); await sleep(9000);
    const n = app.net; const pages = distinctVideoPages(n, 'https://www.youtube.com/watch?v=x1'); const idxX = n.index.filter(i => i.title === 'Vidéo x1').length;
    results.scenarios.S5_duplicate_video_across_playlists = { distinctNeuronsForSameVideoUrl: pages, indexCallsForThatTitle: idxX, jobs: jobsSummary(n) };
    check(pages === 2 && idxX === 2, 'S5: FINDING — the shared video became TWO neurons and was embedded TWICE (dedup uses the page snapshot taken when B was confirmed)');
    await app.ctx.close();
  }

  // ═════ S6 — idempotence: the same playlist imported twice, sequentially (first fully done) ═════
  if (want('S6')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3'] });
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(300), indexMs: 150 }); await sleep(1200); await installToastSpy(app.page);
    await submitPlaylist(app.page, 'PLA'); await allDone(app.net, 1, 60_000); await sleep(1500);
    const first = new Set(app.net.saves.filter(s => s.kind === 'video').map(s => s.id)).size;
    await submitPlaylist(app.page, 'PLA'); await allDone(app.net, 2, 60_000); await sleep(1500);
    const after = new Set(app.net.saves.filter(s => s.kind === 'video').map(s => s.id)).size; const playlists = new Set(app.net.saves.filter(s => s.kind === 'playlist').map(s => s.id)).size;
    results.scenarios.S6_idempotence_same_session = { videoNeuronsAfterFirst: first, videoNeuronsAfterSecond: after, playlistNeuronsAfterSecond: playlists, toasts: (await toasts(app.page)).map(x => x.text) };
    check(first === 3 && after === 3 && playlists === 1, 'S6: re-importing a finished playlist in the same session creates no duplicates (dedup by URL/title on loaded pages)');
    await app.ctx.close();
  }

  // ═════ S7 — reload while A runs (held) and B is queued ═════
  if (want('S7')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], PLB: ['b1', 'b2', 'b3'] });
    const g = gateOnce(b => b.title === 'Vidéo a4');
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(300), indexMs: 200, gate: g.gate }); await sleep(1200); await installToastSpy(app.page);
    await launchBackToBack(app, ['PLA', 'PLB']); await sleep(1500);
    const before = countVideos(app.net, 'a');
    await app.page.reload(); await app.page.getByRole('button', { name: 'Capturer' }).first().waitFor({ timeout: 30_000 }); await installToastSpy(app.page);
    await sleep(12_000); g.d.release(); await sleep(1500);
    const n = app.net; const T = await toasts(app.page);
    results.scenarios.S7_reload_mid_queue = { videosOfAbeforeReload: before, videosOfAafterWait: countVideos(n, 'a'), videosOfBcreated: countVideos(n, 'b'), toasts: T.map(x => x.text), jobs: jobsSummary(n) };
    check(countVideos(n, 'b') === 0, 'S7: FINDING — the queued playlist B is silently lost on reload (queue lives in React state only)');
    check(countVideos(n, 'a') < 6, 'S7: A was interrupted mid-way (partial import, playlist links possibly unsaved)');
    await app.ctx.close();
  }

  // ═════ S8 — an embedding failure (Ollama 503) on one page while the server stays "available" ═════
  if (want('S8')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3'] });
    const app = await openApp(h, { playlists: pls, saveMs: slowVideos(300), indexMs: 150, indexFail: (b) => b.title === 'Vidéo a2' }); await sleep(1200); await installToastSpy(app.page);
    await submitPlaylist(app.page, 'PLA'); await allDone(app.net, 1, 60_000); await sleep(26_000); // > 2 health polls (10 s each)
    const n = app.net; const a2 = n.index.filter(i => i.title === 'Vidéo a2');
    results.scenarios.S8_index_failure_retry = { attemptsForFailedPage: a2.map(i => ({ ok: i.ok })), totalIndexCalls: n.index.length, okCalls: n.index.filter(i => i.ok).length, toasts: (await toasts(app.page)).map(x => x.text) };
    check(a2.length === 1 && a2[0].ok === false, 'S8: FINDING — the failed embedding was attempted once and never retried while the server looks available (offline queue drains only on an unavailable→available transition)');
    check(n.index.filter(i => i.ok).length === n.index.length - 1, 'S8: the other pages were indexed');
    await app.ctx.close();
  }

  // ═════ S9 — idempotence AFTER a restart: only the 50 most recent neurons are loaded, so a re-import duplicates older ones ═════
  if (want('S9')) {
    const pls = makePlaylists({ PLA: ['a1', 'a2', 'a3'] }); const T0 = Date.now();
    const notes = Array.from({ length: 60 }, (_, i) => ({ id: `note-${i}`, title: `Note ${i}`, kind: 'note', links: [], createdAt: T0 - i, updatedAt: T0 - i, metadata: {} }));
    const oldPl = { id: 'old-pl', title: 'Playlist PLA', kind: 'playlist', links: ['old-v1', 'old-v2', 'old-v3'], createdAt: 1, updatedAt: 1, metadata: { url: 'https://www.youtube.com/playlist?list=PLA', playlistId: 'PLA' } };
    const oldVs = ['a1', 'a2', 'a3'].map((v, i) => ({ id: `old-v${i + 1}`, title: `Vidéo ${v}`, kind: 'video', links: ['old-pl'], createdAt: 1, updatedAt: 1, metadata: { url: `https://www.youtube.com/watch?v=${v}`, youtubeId: v, playlistId: 'PLA', light: true } }));
    const app = await openApp(h, { playlists: pls, seedPages: [...notes, oldPl, ...oldVs], saveMs: slowVideos(100), indexMs: 100 }); await sleep(1500); await installToastSpy(app.page);
    await submitPlaylist(app.page, 'PLA'); await allDone(app.net, 1, 60_000); await sleep(1500);
    const n = app.net; const oldIds = new Set(['old-pl', 'old-v1', 'old-v2', 'old-v3']);
    const newVideos = new Set(n.saves.filter(s => s.kind === 'video' && !oldIds.has(s.id)).map(s => s.id)).size; const newPlaylists = new Set(n.saves.filter(s => s.kind === 'playlist' && !oldIds.has(s.id)).map(s => s.id)).size;
    results.scenarios.S9_idempotence_after_restart = { serverAlreadyHasVideos: 3, serverAlreadyHasPlaylistNeuron: 1, newVideoNeuronsCreatedOnReimport: newVideos, newPlaylistNeuronsCreated: newPlaylists, toasts: (await toasts(app.page)).map(x => x.text) };
    check(newVideos === 3 && newPlaylists === 1, 'S9: FINDING — re-importing a playlist whose neurons are older than the 50 loaded stubs creates a second playlist neuron and 3 duplicate video neurons (dedup only sees loaded pages)');
    await app.ctx.close();
  }

  results.assertions = assertions; results.passed = true;
  console.log(`AUDIT BROWSER: ${assertions} observations verified`);
} catch (e) {
  results.passed = false; results.error = e.message; console.error('AUDIT BROWSER FAILED:', e.message); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); clearInterval(saver);
  try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); } catch { /* best effort */ }
  await h?.browser.close(); await h?.server.close();
  console.log(JSON.stringify(results.scenarios).slice(0, 3000));
}
