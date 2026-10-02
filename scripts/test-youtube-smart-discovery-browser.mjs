// YouTube Smart Discovery V2 — REAL src/App.tsx in Chromium. Every /api/** call is mocked by the harness EXCEPT
// POST /api/capture/discover, which is forwarded to a local STREAMING mock server (true NDJSON streaming with delays, holds and
// client-abort detection) so progress, persistence and cancellation are exercised for real.
// Usage: node scripts/test-youtube-smart-discovery-browser.mjs
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startHarness, openApp, until, sleep } from './audit-queue-lib.mjs';

const MOCK_PORT = 3001; // = BASE port of the frontend client; bound ONLY by this mock (EADDRINUSE → abort, the real server is never touched)
const OUT = 'reports/v2-browser-results.json';
const R = { generatedAt: new Date().toISOString(), scenarios: {} };
let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };

// ─── streaming mock of POST /api/capture/discover ───────────────────────────────────────────────────
const mock = { conns: [], config: {}, gates: [] };
const cfg = (patch) => { mock.config = { sizes: { videos: 6, shorts: 8, streams: 3 }, holdAt: null, fail: null, burst: false, ...patch }; };
cfg({});
function tabsFor(input) {
  const m = /\/(videos|shorts|streams)\/?$/.exec(input.replace(/[?#].*$/, ''));
  return m ? [m[1]] : ['videos', 'shorts', 'streams'];
}
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const conn = { input: body.input, context: body.context, startedAt: Date.now(), abortedAt: null, finished: false, phases: [], events: [], gate: null };
    mock.conns.push(conn);
    res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson' });
    res.on('close', () => { if (!conn.finished) { conn.abortedAt = Date.now(); conn.gate?.(); } });
    const send = (e) => { if (conn.abortedAt) return false; res.write(`${JSON.stringify(e)}\n`); conn.events.push(e.type); return true; };
    const tabs = tabsFor(body.input);
    const handle = /@([^/\s?#]+)/.exec(body.input)?.[0] ?? null;
    const sizes = mock.config.sizes;
    send({ type: 'start', input: body.input, at: Date.now() });
    send({ type: 'mode', mode: tabs.length === 3 ? 'CHANNEL_ALL_MEDIA' : { videos: 'CHANNEL_VIDEOS_ONLY', shorts: 'CHANNEL_SHORTS_ONLY', streams: 'CHANNEL_STREAMS_ONLY' }[tabs[0]], kind: 'channel', handle, canonicalUrl: body.input, sources: tabs });
    let total = 0;
    for (const tab of tabs) {
      if (conn.abortedAt) return res.end();
      conn.phases.push(tab);
      send({ type: 'phase_start', tab, index: tabs.indexOf(tab), total: tabs.length });
      send({ type: 'progress', tab, pages: 1, count: 0, total, elapsedMs: 10 });
      if (!mock.config.burst) await sleep(mock.config.phaseMs ?? 1400); // a real phase lasts seconds: keep each phase observable
      if (mock.config.holdAt === tab) { await new Promise(r => { conn.gate = r; mock.gates.push(conn); }); conn.gate = null; if (conn.abortedAt) return res.end(); }
      if (mock.config.fail?.at === tab) {
        send({ type: 'error', name: mock.config.fail.name, code: mock.config.fail.code, message: mock.config.fail.message });
        conn.finished = true; return res.end();
      }
      const n = sizes[tab] ?? 0;
      const media = { videos: 'VIDEO', shorts: 'SHORT', streams: 'STREAM' }[tab];
      let sent = 0;
      while (sent < n) {
        const size = Math.min(100, n - sent);
        const items = Array.from({ length: size }, (_, i) => {
          const id = `${tab[0]}${String(sent + i).padStart(10, '0')}`.slice(0, 11);
          return { id, title: `${media} ${sent + i + 1}`, url: tab === 'shorts' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/oar3.jpg`, sourceChannel: 'Example', sourceTab: tab, mediaType: media };
        });
        sent += size; total += size;
        send({ type: 'items_batch', tab, items, total });
        if (mock.config.burst) { send({ type: 'progress', tab, pages: Math.ceil(sent / 30), count: sent, total, elapsedMs: sent }); await sleep(4); }
      }
      send({ type: 'phase_done', tab, count: n, available: n > 0, pages: Math.max(1, Math.ceil(n / 30)), durationMs: 20, total });
    }
    send({ type: 'done', mode: 'x', total, counts: { videos: sizes.videos, shorts: sizes.shorts, streams: sizes.streams }, duplicates: 0, durationMs: 100, channel: { handle, url: body.input, title: 'Example - channel', uploader: 'Example', id: 'UCexample' }, merged: [] });
    conn.finished = true; res.end();
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(MOCK_PORT, '127.0.0.1', resolve); });
const releaseAll = () => { for (const c of mock.gates.splice(0)) c.gate?.(); };

// ─── driver helpers ─────────────────────────────────────────────────────────────────────────────────
const h = await startHarness({ port: 5236 });
// The harness page is a Playwright-fulfilled document (no address space) → Chrome's Private Network Access would block its
// call to the loopback streaming mock. Relaunch Chromium with PNA/LNA checks off (test browser only).
await h.browser.close();
h.browser = await chromium.launch({ headless: true, args: ['--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks,LocalNetworkAccessChecksWarn'] });
const open = (opts = {}) => openApp(h, { playlists: {}, extra: async ({ route, p, m }) => {
  if (p === '/api/capture/discover' && m === 'POST') { await route.continue(); return true; /* real network → the local streaming mock on :3001 */ }
  return false;
}, indexMs: 30, ...opts });
const panel = (page) => page.locator('[data-testid="yt-discovery-panel"]');
async function submit(page, text) {
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('textarea').fill(text);
  await page.locator('.modal-box').getByRole('button', { name: /Capturer|Analyse profonde/ }).click();
}
async function watchStatuses(page) {
  await page.evaluate(() => {
    window.__st = []; window.__panelMutations = 0;
    const read = () => { const el = document.querySelector('[data-testid="yt-discovery-status"]'); if (el && window.__st[window.__st.length - 1] !== el.textContent) window.__st.push(el.textContent); };
    new MutationObserver(() => { window.__panelMutations += 1; read(); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}
const statuses = (page) => page.evaluate(() => window.__st);
const text = (page, id) => page.locator(`[data-testid="${id}"]`).innerText();
const closeApp = async (app) => { await app.ctx.close(); };
const finish = (name, data) => { R.scenarios[name] = data; fs.writeFileSync(OUT, JSON.stringify(R, null, 1)); console.log('ok', name); };

try {
  // ═══ S1 — static + modal: no 25/50/100/Tous, automatic mode hint ═══
  {
    const src = fs.readFileSync('src/App.tsx', 'utf8');
    const panelSrc = fs.readFileSync('src/components/panels/YouTubeDiscoveryPanel.tsx', 'utf8');
    check(!/collectionLimit|onCollectionLimitChange|setCollectionLimit/.test(src), 'no collection-limit state/props left in App.tsx');
    check(!/Limite de (Shorts|vidéos)/.test(src + panelSrc), 'no "Limite de" label');
    check(!/<option value=\{(25|50|100)\}>|<option value="all">/.test(src), 'no 25/50/100/Tous <option>');
    const client = fs.readFileSync('src/lib/cortex/client.ts', 'utf8');
    check(!/mode:\s*'limited'|limit\?: 25 \| 50 \| 100/.test(client.slice(client.indexOf('async discoverYouTube'))), 'client discovery contract has no limit/mode');
    const app = await open();
    await app.page.getByRole('button', { name: 'Capturer' }).first().click();
    await app.page.locator('textarea').fill('https://www.youtube.com/@example');
    const modal = app.page.locator('.modal-box');
    eq(await modal.locator('select').count(), 0, 'no <select> in the capture modal for a channel URL');
    const modalText = await modal.innerText();
    check(!/Limite de/.test(modalText), 'no limit label'); eq(await modal.locator('option').count(), 0, 'no <option>'); eq(await modal.getByRole('button', { name: /^(25|50|100|ALL|Tous|Tout)$/ }).count(), 0, 'no 25/50/100/ALL buttons'); eq(await modal.getByRole('radio').count(), 0, 'no radio');
    check(/mode automatique/.test(modalText) && /Tous les médias/.test(modalText), 'root URL shows automatic mode "Tous les médias"');
    await app.page.locator('textarea').fill('https://www.youtube.com/@example/shorts');
    check(/Shorts uniquement/.test(await modal.innerText()), '/shorts → Shorts uniquement');
    await app.page.locator('textarea').fill('https://www.youtube.com/@example/videos');
    check(/Vidéos uniquement/.test(await modal.innerText()), '/videos → Vidéos uniquement');
    await app.page.locator('textarea').fill('https://www.youtube.com/@example/streams');
    check(/Streams uniquement/.test(await modal.innerText()), '/streams → Streams uniquement');
    for (const notChannel of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/playlist?list=PLabcdef', 'https://www.youtube.com/@example/live', '@example']) {
      await app.page.locator('textarea').fill(notChannel);
      check(!/mode automatique/.test(await modal.innerText()), `no channel discovery hint for ${notChannel}`);
    }
    await app.page.locator('textarea').fill('yt @example');
    check(/Tous les médias/.test(await modal.innerText()), 'explicit YouTube workflow accepts a bare @handle');
    await closeApp(app);
    finish('S1_static_modal', { ok: true });
  }

  // ═══ S2 — root channel: persistent panel, cancel visible, per-type progress, items before done, typed import ═══
  {
    cfg({ holdAt: 'shorts', sizes: { videos: 6, shorts: 8, streams: 3 } }); mock.conns.length = 0;
    const app = await open({ health: false /* Ollama-free: discovery must not depend on it */ });
    await watchStatuses(app.page);
    const t0 = Date.now();
    await submit(app.page, 'https://www.youtube.com/@example');
    await panel(app.page).waitFor({ timeout: 3000 });
    const firstPanelMs = Date.now() - t0;
    eq(await app.page.locator('.modal-box').count(), 0, 'capture modal closed, panel took over');
    check(await app.page.locator('[data-testid="yt-discovery-cancel"]').isVisible(), 'cancel visible immediately');
    check(/@example/.test(await text(app.page, 'yt-discovery-channel')), 'channel handle shown');
    check(/Tous les médias/.test(await text(app.page, 'yt-discovery-mode')), 'mode shown');
    // the videos phase is finished and its items counted while Shorts is being searched
    await until(async () => /Recherche Shorts/.test(await text(app.page, 'yt-discovery-status')), 8000, 100);
    const phases = await text(app.page, 'yt-discovery-phases');
    check(/Vidéos : 6 trouvé/.test(phases), `videos count visible while shorts runs: ${phases}`);
    check(/Streams : en attente/.test(phases), 'streams pending');
    check(/Total unique : 6/.test(await text(app.page, 'yt-discovery-total')), 'total unique visible');
    // persistence: nothing disappears during a long silent phase, cancel stays reachable
    const secs = async () => { const t = await text(app.page, 'yt-discovery-elapsed'); const m = /(?:(\d+) min )?(\d+) s/.exec(t); return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : -1; };
    const s0 = await secs();
    await sleep(3500);
    check(await panel(app.page).isVisible() && await app.page.locator('[data-testid="yt-discovery-cancel"]').isVisible(), 'panel + cancel persist during the long phase');
    check(await secs() >= s0 + 2, `elapsed timer runs (${s0} → ${await secs()})`);
    releaseAll();
    await until(async () => (await panel(app.page).getAttribute('data-status')) === 'done', 10_000, 100);
    check(/Terminé : 17 élément/.test(await text(app.page, 'yt-discovery-status')), 'done text');
    check(/Total unique : 17/.test(await text(app.page, 'yt-discovery-total')), 'total unique 17');
    const sts = await statuses(app.page);
    check(sts.some(t => /Recherche vidéos/.test(t)) && sts.some(t => /Recherche Shorts/.test(t)) && sts.some(t => /Recherche streams/.test(t)), `all three phases announced: ${JSON.stringify(sts)}`);
    // import (17 < 30: no confirm) → typed metadata, /shorts URLs preserved, no cross-type mixing
    await until(async () => new Set(app.net.saves.filter(s => s.kind === 'video').map(v => v.id)).size >= 17, 180_000, 500);
    const vids = [...new Map(app.net.saves.filter(s => s.kind === 'video').map(v => [v.id, v])).values()];
    eq(new Set(vids.map(v => v.id)).size, 17, 'every discovered item imported once');
    eq(vids.filter(v => /\/shorts\//.test(v.url ?? '')).length, 8, '8 Shorts keep /shorts/ URLs');
    eq(vids.filter(v => /watch\?v=/.test(v.url ?? '')).length, 9, '9 videos/streams keep watch URLs');
    check(app.net.errors.filter(e => !/outputs is not iterable/.test(e)).length === 0, `no page errors: ${app.net.errors}`);
    finish('S2_root', { firstPanelMs, statuses: sts, mutations: await app.page.evaluate(() => window.__panelMutations), conns: mock.conns.map(c => ({ input: c.input, phases: c.phases })) });
    await closeApp(app);
  }

  // ═══ S3 — explicit tabs only show / request their own tab ═══
  for (const tab of ['shorts', 'videos', 'streams']) {
    cfg({ sizes: { videos: 5, shorts: 6, streams: 4 } }); mock.conns.length = 0;
    const app = await open();
    await watchStatuses(app.page);
    await submit(app.page, `https://www.youtube.com/@example/${tab}`);
    await panel(app.page).waitFor({ timeout: 3000 });
    await until(async () => (await panel(app.page).getAttribute('data-status')) === 'done', 15_000, 100);
    const rows = await app.page.locator('[data-testid="yt-discovery-phases"] li').evaluateAll(els => els.map(e => e.getAttribute('data-tab')));
    assert.deepEqual(rows, [tab]); assertions += 1;
    assert.deepEqual(mock.conns[0].phases, [tab]); assertions += 1;
    const sts = (await statuses(app.page)).join(' | ');
    for (const other of ['vidéos', 'Shorts', 'streams'].filter(x => x.toLowerCase().replace('é', 'e') !== (tab === 'videos' ? 'videos' : tab).toLowerCase().replace('é', 'e'))) {
      check(!new RegExp(`Recherche ${other}`).test(sts), `${tab}: no "Recherche ${other}" in ${sts}`);
    }
    check(!/Total unique/.test(await text(app.page, 'yt-discovery-total')) && /trouvé/.test(await text(app.page, 'yt-discovery-total')), `${tab}: single-tab progress shows a plain count`);
    finish(`S3_tab_${tab}`, { rows, statuses: sts });
    await closeApp(app);
  }

  // ═══ S4 — @handle only inside the explicit YouTube workflow ═══
  {
    cfg({ sizes: { videos: 2, shorts: 2, streams: 1 } }); mock.conns.length = 0;
    const app = await open();
    await submit(app.page, '@example');
    await sleep(1500);
    eq(mock.conns.length, 0, 'bare @handle in the generic capture field does NOT start a YouTube discovery');
    eq(await panel(app.page).count(), 0, 'no panel for a bare @handle');
    await app.page.reload(); await app.page.getByRole('button', { name: 'Capturer' }).first().waitFor({ timeout: 30_000 });
    await submit(app.page, 'yt @example');
    await panel(app.page).waitFor({ timeout: 3000 });
    check(/Chaîne YouTube détectée : @example/.test(await text(app.page, 'yt-discovery-channel')), 'panel announces the handle');
    check(/Tous les médias/.test(await text(app.page, 'yt-discovery-mode')), 'handle → all media');
    await until(async () => mock.conns.length > 0, 5000, 50);
    eq(mock.conns[0].input, '@example', 'handle sent as-is');
    eq(mock.conns[0].context, 'youtube', 'explicit youtube context sent');
    finish('S4_handle', { conns: mock.conns.map(c => ({ input: c.input, context: c.context })) });
    await closeApp(app);
  }

  // ═══ S5 — cancel during the Shorts phase: kill propagated, later phases never start, clear CANCELLED state, nothing imported ═══
  {
    cfg({ holdAt: 'shorts', sizes: { videos: 40, shorts: 80, streams: 5 } }); mock.conns.length = 0;
    const app = await open();
    await submit(app.page, 'https://www.youtube.com/@example');
    await until(async () => /Recherche Shorts/.test(await text(app.page, 'yt-discovery-status').catch(() => '')), 8000, 100);
    const tClick = Date.now();
    await app.page.locator('[data-testid="yt-discovery-cancel"]').click();
    await until(async () => (await panel(app.page).getAttribute('data-status')) === 'cancelled', 5000, 50);
    const uiMs = Date.now() - tClick;
    await until(async () => mock.conns[0].abortedAt !== null, 5000, 20);
    const abortMs = mock.conns[0].abortedAt - tClick;
    check(/Annulé/.test(await text(app.page, 'yt-discovery-status')), 'Annulé state shown');
    check(await app.page.getByRole('button', { name: 'Fermer la découverte YouTube' }).isVisible(), 'close button after cancel');
    eq(await app.page.locator('[data-testid="yt-discovery-cancel"]').count(), 0, 'cancel button gone once cancelled');
    check(!mock.conns[0].phases.includes('streams'), 'streams phase never started after cancel');
    eq(app.net.saves.filter(s => s.kind === 'video').length, 0, 'nothing imported after cancel');
    check(await app.page.getByRole('button', { name: 'Continuer' }).count() === 0, 'no import confirmation after cancel');
    check(uiMs < 20_000 && abortMs < 20_000, /* headless software-WebGL keeps the page main thread ~saturated (long tasks ~0.5 s): real latency is measured against the real server */ `cancel latency ui=${uiMs} ms, connection closed=${abortMs} ms`);
    // a new discovery can start right after
    cfg({ sizes: { videos: 1, shorts: 1, streams: 1 } });
    await app.page.getByRole('button', { name: 'Fermer la découverte YouTube' }).click();
    await submit(app.page, 'https://www.youtube.com/@example/shorts');
    await until(async () => (await panel(app.page).getAttribute('data-status')) === 'done', 10_000, 100);
    finish('S5_cancel', { uiMs, abortMs, phases: mock.conns[0].phases });
    await closeApp(app);
  }

  // ═══ S6 — error visibility: timeout / yt-dlp error / invalid ═══
  for (const [name, fail, expectStatus, re] of [
    ['timeout', { at: 'shorts', name: 'TimeoutError', code: 'DISCOVERY_STALLED', message: 'yt-dlp ne répond plus (aucune activité depuis 90 s)' }, 'timeout', /Timeout : yt-dlp ne répond plus/],
    ['ytdlp_error', { at: 'videos', name: 'Error', code: 'YTDLP_ERROR', message: 'Vidéo supprimée ou indisponible' }, 'error', /Erreur yt-dlp : Vidéo supprimée/],
  ]) {
    cfg({ fail, sizes: { videos: 3, shorts: 3, streams: 3 } }); mock.conns.length = 0;
    const app = await open();
    await submit(app.page, 'https://www.youtube.com/@example');
    await until(async () => (await panel(app.page).getAttribute('data-status')) === expectStatus, 10_000, 100);
    check(re.test(await text(app.page, 'yt-discovery-status')), `${name}: message visible`);
    eq(await app.page.locator('[data-testid="yt-discovery-cancel"]').count(), 0, `${name}: no cancel after failure`);
    await app.page.getByRole('button', { name: 'Fermer la découverte YouTube' }).click();
    eq(await panel(app.page).count(), 0, `${name}: panel closable`);
    finish(`S6_${name}`, { ok: true });
    await closeApp(app);
  }

  // ═══ S7 — cross-task isolation (both directions) ═══
  {
    const articleBody = { fallback: false, captureId: 'cap-x', parent: null, child: { title: 'Article X', kind: 'link', content: 'Résumé.', metadata: { url: 'https://example.com/article', deep_capture: true, captureId: 'cap-x', captureStatus: 'EXTRACTED' } } };
    // 7a: cancel YouTube while an article/deep capture runs → the article completes
    {
      cfg({ holdAt: 'shorts', sizes: { videos: 2, shorts: 2, streams: 1 } }); mock.conns.length = 0;
      let deepAborted = false; let release;
      const gate = new Promise(r => { release = r; });
      const app = await open({ capture: async (route, _p, _b, _n, _now, json) => { await gate; return json(route, articleBody).catch(() => { deepAborted = true; }); } });
      await submit(app.page, 'https://www.youtube.com/@example');
      await until(async () => /Recherche Shorts/.test(await text(app.page, 'yt-discovery-status').catch(() => '')), 8000, 100);
      await submit(app.page, 'info https://example.com/article'); // deep capture while discovery runs
      await sleep(800);
      check(await app.page.getByRole('button', { name: 'Annuler la capture' }).isVisible(), 'deep capture running with its own cancel');
      await app.page.locator('[data-testid="yt-discovery-cancel"]').click();
      await until(async () => (await panel(app.page).getAttribute('data-status')) === 'cancelled', 5000, 50);
      check(await app.page.getByRole('button', { name: 'Annuler la capture' }).isVisible(), 'deep capture still running after the YouTube cancel');
      release();
      await until(async () => app.net.saves.some(s => s.captureStatus === 'READY'), 20_000, 200);
      check(!deepAborted, 'article request was not aborted');
      check(app.net.saves.some(s => s.captureStatus === 'READY'), 'article capture completed after the YouTube cancel');
      finish('S7a_cancel_youtube_article_continues', { ok: true });
      await closeApp(app);
    }
    // 7b: cancel the deep capture while YouTube discovery runs → discovery continues and completes
    {
      cfg({ holdAt: 'shorts', sizes: { videos: 2, shorts: 2, streams: 1 } }); mock.conns.length = 0;
      const app = await open({ capture: async (route) => { await sleep(60_000).catch(() => {}); return route.abort().catch(() => {}); } });
      await submit(app.page, 'https://www.youtube.com/@example');
      await until(async () => /Recherche Shorts/.test(await text(app.page, 'yt-discovery-status').catch(() => '')), 8000, 100);
      await submit(app.page, 'info https://example.com/article');
      await sleep(800);
      await app.page.getByRole('button', { name: 'Annuler la capture' }).click();
      await sleep(800);
      eq(await panel(app.page).getAttribute('data-status'), 'running', 'discovery still running after the deep-capture cancel');
      eq(mock.conns[0].abortedAt, null, 'discovery connection not aborted by the deep-capture cancel');
      check(await app.page.locator('[data-testid="yt-discovery-cancel"]').isVisible(), 'discovery cancel still available');
      releaseAll();
      await until(async () => (await panel(app.page).getAttribute('data-status')) === 'done', 10_000, 100);
      finish('S7b_cancel_article_youtube_continues', { ok: true });
      await closeApp(app);
    }
  }

  // ═══ S8 — large channel (2573 Shorts): batched UI updates, no thumbnail storm, no freeze ═══
  {
    cfg({ sizes: { videos: 0, shorts: 2573, streams: 0 }, burst: true }); mock.conns.length = 0;
    const app = await open();
    await watchStatuses(app.page);
    await app.page.evaluate(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch { /* */ } });
    const heap0 = await app.page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    const t0 = Date.now();
    await submit(app.page, 'https://www.youtube.com/@example/shorts');
    await until(async () => (await panel(app.page).getAttribute('data-status')) === 'done', 60_000, 100);
    const ms = Date.now() - t0;
    check(/Terminé : 2573 élément/.test(await text(app.page, 'yt-discovery-status')), '2573 items reached the UI');
    await app.page.getByRole('button', { name: 'Continuer' }).waitFor({ timeout: 15_000 });
    const confirmText = await app.page.locator('.modal-box').last().innerText();
    check(/2573/.test(confirmText), 'confirm dialog announces the real count');
    const mutations = await app.page.evaluate(() => window.__panelMutations);
    const lt = await app.page.evaluate(() => window.__lt);
    const heap1 = await app.page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    const thumbs = app.net.external.filter(u => /ytimg/.test(u)).length;
    eq(thumbs, 0, 'no thumbnail request storm during discovery');
    check(mutations < 120, `UI updates are batched (${mutations} DOM mutation callbacks for 2573 items)`);
    await app.page.locator('.modal-box').last().getByRole('button', { name: 'Annuler' }).click();
    finish('S8_large', { items: 2573, discoveryMs: ms, domMutationCallbacks: mutations, longTasks: { count: lt.length, maxMs: Math.max(0, ...lt) }, heapGrowthMb: +((heap1 - heap0) / 1048576).toFixed(1), thumbnailRequests: thumbs });
    await closeApp(app);
  }

  R.assertions = assertions; R.result = 'PASS';
} catch (err) {
  R.result = 'FAIL'; R.error = err.stack ?? String(err); console.error(err);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`assertions: ${assertions} — ${R.result}`);
  server.close(); await h.browser.close(); await h.server.close(); process.exit(process.exitCode ?? 0);
}
