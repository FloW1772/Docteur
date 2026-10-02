// AUDIT ONLY — large Shorts channel, FRONTEND side. Mounts the REAL src/App.tsx in Chromium with a mocked network
// (no real server / DB / YouTube). The discovery response is a SYNTHETIC replay with the exact shape the real route produced
// (started, N progress {count} lines, one giant `done` line with N {id,title,url(/shorts/),thumbnail} items).
// Records: limit actually transmitted, UI text while waiting, UI cost of consuming the `done` line, long tasks, JS heap,
// post-discovery per-item cost (neurons, PUT, index), thumbnail requests, and the error messages the user sees.
// Nothing in the product is modified. Usage: node scripts/audit-shorts-frontend.mjs
import fs from 'node:fs';
import { startHarness, openApp, sleep, until } from './audit-queue-lib.mjs';

const OUT = 'reports/audit-shorts-frontend-results.json';
const R = { generatedAt: new Date().toISOString(), note: 'synthetic replay of the real NDJSON shape; route.fulfill delivers the body in one piece (no true streaming from the mock)', scenarios: {} };
const SHORTS = 'https://www.youtube.com/@Ines-n9m/shorts';
const fixture = (n) => Array.from({ length: n }, (_, i) => { const id = `S${String(i).padStart(4, '0')}abcde`.slice(0, 11); return { id, title: `Short ${i + 1}`, url: `https://www.youtube.com/shorts/${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/oar3.jpg?sqp=-oaymwEgCJUDEOAESFWQAgHyq4qpAw8IARUAAIhCcAHAAQbIAQE=&rs=AOn4CLAKN8EsLgNa3NaTpZGqXHFe-SN_bA&usqp=CCk` }; });
const ndjson = (n, { mode, limit, progress = true, err = null } = {}) => {
  const lines = [{ type: 'started', mode, limit: limit ?? null }];
  if (err) { lines.push({ type: 'error', name: err.name, message: err.message }); return lines.map(l => JSON.stringify(l)).join('\n') + '\n'; }
  if (progress) for (let i = 1; i <= n; i++) lines.push({ type: 'progress', count: i });
  const videos = fixture(n);
  lines.push({ type: 'done', result: { title: '🪽 𝐈𝐍𝐄𝐒 🪽 - Shorts', uploader: '🪽 𝐈𝐍𝐄𝐒 🪽', playlistId: 'UCkVv-e3hXZd_V2CTQSgsmSg', source_type: 'channel_shorts', mode, limit: limit ?? null, requested_limit: limit ?? null, returned_count: n, video_count: n, limit_reached: mode === 'limited' && n >= limit, has_more: mode === 'all' ? false : null, videos } });
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
};

const h = await startHarness({ port: 5235 });
const save = () => fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
async function scenario(name, { n, optionValue, delayMs = 1500, err = null, observeMs = 0, doImport = false, cancelAfterMs = null }) {
  const req = []; let fulfilledAt = null;
  const extra = async ({ route, p, m, body, now }) => {
    if (p === '/api/capture/playlist' && m === 'POST') {
      const b = body(); req.push({ at: now(), body: b }); await new Promise(r => setTimeout(r, delayMs));
      const mode = b.mode; const limit = b.limit;
      fulfilledAt = now();
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/x-ndjson' }, body: ndjson(n, { mode, limit, err }) }).catch(() => {}); return true;
    } return false;
  };
  const app = await openApp(h, { playlists: {}, extra, indexMs: 50 });
  const { page, net } = app;
  await page.evaluate(() => { window.__lt = []; window.__phase = []; window.__seen = []; const re = /(Erreur \/ timeout pendant la recherche de Shorts|Impossible de récupérer les infos de la chaîne|Recherche de Shorts annulée|Terminé : \d+ Shorts|\d+ Shorts récupérés.*)/; const t0 = performance.now(); new MutationObserver(() => { const m = document.body.innerText.match(re); if (m && !window.__seen.some(x => x.text === m[1])) window.__seen.push({ at: Math.round(performance.now() - t0), text: m[1] }); }).observe(document.body, { childList: true, subtree: true, characterData: true }); try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] }); } catch { /* */ } });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const heap = async () => { const m = await cdp.send('Performance.getMetrics'); const o = Object.fromEntries(m.metrics.map(x => [x.name, x.value])); return { jsHeapMb: +(o.JSHeapUsedSize / 1048576).toFixed(1), nodes: o.Nodes, taskDurationS: +o.TaskDuration.toFixed(2) }; };
  const out = { optionValue, n, heapBefore: await heap() };
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('textarea').fill(SHORTS);
  const sel = page.locator('.modal-box select'); await sel.waitFor({ timeout: 10_000 });
  out.optionsOffered = await sel.locator('option').allTextContents(); await sel.selectOption(String(optionValue));
  const tClick = Date.now();
  await page.locator('.modal-box').getByRole('button', { name: 'Capturer' }).click();
  await until(async () => req.length > 0, 10_000, 20); out.requestBody = req[0]?.body;
  // what the user reads while waiting
  await sleep(Math.min(delayMs / 2, 600)); out.uiTextWhileWaiting = await page.evaluate(() => { const p = document.querySelector('.modal-box p.font-mono'); return p ? p.textContent : null; });
  if (cancelAfterMs) { await sleep(cancelAfterMs); await page.getByRole('button', { name: 'Annuler la capture' }).click().catch(() => {}); await sleep(600); out.cancelToast = await page.evaluate(() => (document.body.innerText.match(/Recherche de Shorts annulée[^\n]*/) ?? [null])[0]); out.modalBusyAfterCancel = await page.getByRole('button', { name: 'Annuler la capture' }).count(); save(); await app.ctx.close(); R.scenarios[name] = out; return out; }
  if (err) { await until(async () => (await page.evaluate(() => window.__seen.length)) > 0, 15_000, 100); out.userVisibleMessage = await page.evaluate(() => window.__seen); out.errorTypeDistinguishable = 'toast text differs only for TimeoutError vs any other error; no cause (yt-dlp stderr / cancelled-by-server) shown'; await app.ctx.close(); R.scenarios[name] = out; save(); return out; }
  const confirmBtn = page.getByRole('button', { name: 'Continuer' });
  const createdDirect = n <= 30;
  if (!createdDirect) { await confirmBtn.waitFor({ timeout: 60_000 }); out.doneToConfirmDialogMs = Date.now() - tClick; out.confirmDialogText = await page.locator('.modal-box').last().innerText().then(t => t.replace(/\s+/g, ' ').slice(0, 200)).catch(() => null); out.heapAtConfirm = await heap(); out.longTasksDuringDiscovery = await page.evaluate(() => window.__lt.slice()); out.falseZeroShortsShown = /(^|\D)0 Shorts/.test(await page.evaluate(() => document.body.innerText)); if (doImport) { const tImp = Date.now(); await confirmBtn.click(); out.import = { samples: [] }; const until_ = Date.now() + observeMs; while (Date.now() < until_) { await sleep(5000); const sv = net.saves.filter(s => s.kind === 'video').length; const ix = net.index.length; out.import.samples.push({ tS: Math.round((Date.now() - tImp) / 1000), videoSaves: sv, indexCalls: ix, ...(await heap()) }); } out.import.longTasks = await page.evaluate(() => ({ count: window.__lt.length, maxMs: Math.max(0, ...window.__lt.map(x => x.d)), totalMs: window.__lt.reduce((a, x) => a + x.d, 0) })); const last = out.import.samples.at(-1); out.import.itemsPerSecond = +(last.videoSaves / last.tS).toFixed(2); out.import.projectedFullImportMinutes = +(n / out.import.itemsPerSecond / 60).toFixed(1); out.import.maxSimultaneousIndex = net.indexMax; out.import.thumbnailRequests = net.external.filter(u => /ytimg/.test(u)).length; out.import.youtubeRequestsOther = net.external.filter(u => !/ytimg/.test(u)).length; out.import.neuronsSavedUrlsKeepShorts = net.saves.filter(s => s.kind === 'video').every(s => /\/shorts\//.test(s.url ?? '')); } }
  else { await sleep(1500); out.videoSavesAfter1_5s = net.saves.filter(s => s.kind === 'video').length; }
  out.thumbnailRequestsBeforeImport = net.external.filter(u => /ytimg/.test(u)).length; out.pageErrors = net.errors.slice(0, 5);
  await app.ctx.close(); R.scenarios[name] = out; save(); console.log(name, JSON.stringify({ body: out.requestBody, text: out.uiTextWhileWaiting, toConfirmMs: out.doneToConfirmDialogMs, thumbs: out.thumbnailRequestsBeforeImport, import: out.import && { ips: out.import.itemsPerSecond, proj: out.import.projectedFullImportMinutes, lt: out.import.longTasks, thumbs: out.import.thumbnailRequests } })); return out;
}
try {
  { const app = await openApp(h, { playlists: {} }); await app.page.evaluate(() => { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ entryTypes: ['longtask'] }); }); await sleep(20_000); R.scenarios.idle_baseline_20s = { longTasks: await app.page.evaluate(() => ({ count: window.__lt.length, maxMs: Math.round(Math.max(0, ...window.__lt)), totalMs: Math.round(window.__lt.reduce((a, x) => a + x, 0)) })), note: 'app idle, no discovery: headless software WebGL of the 3D scene already saturates the main thread' }; await app.ctx.close(); }
  await scenario('limit_25', { n: 25, optionValue: 25 });
  await scenario('limit_50', { n: 50, optionValue: 50 });
  await scenario('limit_100', { n: 100, optionValue: 100 });
  await scenario('all_2573_replay', { n: 2573, optionValue: 'all', delayMs: 4000, doImport: true, observeMs: 60_000 });
  await scenario('err_timeout', { n: 0, optionValue: 'all', err: { name: 'TimeoutError', message: 'Délai d’inactivité de la découverte YouTube dépassé' } });
  await scenario('err_ytdlp', { n: 0, optionValue: 'all', err: { name: 'Error', message: 'yt-dlp: HTTP Error 429' } });
  await scenario('cancel_during_all', { n: 2573, optionValue: 'all', delayMs: 8000, cancelAfterMs: 1500 });
} catch (e) { R.fatal = e.stack; console.error(e); } finally { save(); await h.browser.close(); await h.server.close(); process.exit(0); }
