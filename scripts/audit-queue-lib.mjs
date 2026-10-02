// AUDIT helper (playlist / indexing queue feasibility). Mounts the REAL src/App.tsx in Chromium with a fully mocked
// network (no real server, no real DB, no real YouTube) and records what the frontend queue actually does.
// Nothing here modifies product code.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/audit-queue-harness.jsx");mount();</script>';

export async function startHarness({ port = 5231 } = {}) {
  const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-audit', plugins: [react()], optimizeDeps: { entries: ['scripts/audit-queue-harness.jsx'] }, server: { watch: null, host: '0.0.0.0', port, strictPort: true, allowedHosts: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  return { server, browser, origin: `http://127.0.0.1:${port}` };
}

// A playlist fixture: id → { title, uploader, videos: [{id,title}] }
export function makePlaylists(spec) {
  const out = {};
  for (const [id, vids] of Object.entries(spec)) out[id] = { playlistId: id, title: `Playlist ${id}`, uploader: `Chaîne ${id}`, videos: vids.map(v => ({ id: v, title: `Vidéo ${v}`, url: `https://www.youtube.com/watch?v=${v}`, duration: 60 })) };
  return out;
}

// Opens the app with a mocked API. `net` is the mutable model the test reads afterwards.
export async function openApp({ browser, origin }, { remote = false, seedPages = [], playlists, discoveryMs = {}, indexMs = 200, indexFail = () => false, saveFail = () => false, saveMs = () => 0, gate = () => null, health = true, capture = null, extra = null } = {}) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const net = { t0: Date.now(), discovery: [], index: [], indexActive: 0, indexMax: 0, saves: [], jobs: [], errors: [], external: [], toasts: [] };
  const now = () => Date.now() - net.t0;
  page.on('pageerror', e => net.errors.push(e.message));
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  await page.route('**/api/**', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname; const m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = () => { try { return req.postDataJSON(); } catch { return {}; } };
    if (extra) { const handled = await extra({ route, p, m, body, json, net, now, url: u }); if (handled) return; }
    if (p === '/api/ping') return json(route, { ok: true });
    if (p === '/api/health') return json(route, { status: 'ok', ollama_connected: health, ollama_url: 'x', embedding_model: 'm', answer_model: 'm', lancedb: { rows: 0 } });
    const stub = (x) => ({ id: x.id, title: x.title, kind: x.kind, links: x.links ?? [], metadata: x.metadata, createdAt: x.createdAt, updatedAt: x.updatedAt });
    if (p === '/api/neurons/recent') return json(route, { pages: seedPages.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50).map(stub) });
    if (p === '/api/neurons/all-meta') return json(route, { pages: seedPages.map(stub) });
    if (p === '/api/neurons') return json(route, { pages: seedPages });
    if (p === '/api/neurons/counts') return json(route, { total: seedPages.length, byKind: {} });
    if (p.startsWith('/api/neuron/') && m === 'PUT') { const b = body().page ?? {}; net.saves.push({ at: now(), id: b.id, title: b.title, kind: b.kind, url: b.metadata?.url, captureId: b.metadata?.captureId, captureStatus: b.metadata?.captureStatus, fallbackReason: b.metadata?.capture_fallback_reason, captureWarning: b.metadata?.captureWarning, links: b.links?.length ?? 0 }); const gp = gate(b); if (gp) await gp; const d = saveMs(b); if (d) await new Promise(r => setTimeout(r, d)); if (saveFail(b)) return json(route, { error: 'db' }, 500); return json(route, { ok: true }); }
    if (p === '/api/index' && m === 'POST') {
      const b = body(); const rec = { id: b.id, title: b.title, kind: b.kind, start: now(), end: null, ok: null }; net.index.push(rec); net.indexActive++; net.indexMax = Math.max(net.indexMax, net.indexActive);
      await new Promise(r => setTimeout(r, indexMs)); net.indexActive--; rec.end = now();
      if (indexFail(b)) { rec.ok = false; return json(route, { error: 'ollama' }, 503); }
      rec.ok = true; return json(route, { ok: true, dimensions: 768, embedding_ms: 1, lancedb_ms: 1, latency_ms: 2 });
    }
    if (p === '/api/capture/discover' && m === 'POST') { // Smart Discovery V2 route (playlist fixtures → events)
      const b = body(); const id = new URL(b.input).searchParams.get('list'); const pl = playlists[id]; const rec = { id, start: now(), end: null }; net.discovery.push(rec);
      await new Promise(r => setTimeout(r, discoveryMs[id] ?? 150)); rec.end = now();
      const nd = (events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
      const headers = { ...cors, 'content-type': 'application/x-ndjson' };
      if (!pl) return route.fulfill({ status: 200, headers, body: nd([{ type: 'start', input: b.input, at: Date.now() }, { type: 'error', name: 'Error', code: 'YTDLP_ERROR', message: 'unknown playlist' }]) });
      const items = pl.videos.map(v => ({ ...v, sourceTab: 'playlist', mediaType: 'VIDEO' }));
      return route.fulfill({ status: 200, headers, body: nd([
        { type: 'start', input: b.input, at: Date.now() }, { type: 'mode', mode: 'PLAYLIST_ONLY', kind: 'playlist', handle: null, canonicalUrl: b.input, sources: ['playlist'] },
        { type: 'phase_start', tab: 'playlist', index: 0, total: 1 }, { type: 'items_batch', tab: 'playlist', items, total: items.length },
        { type: 'phase_done', tab: 'playlist', count: items.length, available: true, pages: 1, durationMs: 1, total: items.length },
        { type: 'done', mode: 'PLAYLIST_ONLY', total: items.length, counts: { playlist: items.length }, duplicates: 0, durationMs: 1, channel: { handle: null, url: b.input, title: pl.title, uploader: pl.uploader, id: pl.playlistId }, merged: [] },
      ]) });
    }
    if (p === '/api/capture/playlist' && m === 'POST') {
      const b = body(); const id = new URL(b.url).searchParams.get('list'); const pl = playlists[id]; const rec = { id, start: now(), end: null }; net.discovery.push(rec);
      await new Promise(r => setTimeout(r, discoveryMs[id] ?? 150)); rec.end = now();
      if (!pl) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/x-ndjson' }, body: `${JSON.stringify({ type: 'error', name: 'Error', message: 'unknown playlist' })}\n` });
      const result = { title: pl.title, uploader: pl.uploader, playlistId: pl.playlistId, video_count: pl.videos.length, videos: pl.videos, source_type: 'playlist', mode: 'limited', limit: 100, requested_limit: 100, returned_count: pl.videos.length, limit_reached: false, has_more: false };
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/x-ndjson' }, body: `${JSON.stringify({ type: 'started', mode: 'limited', limit: 100 })}\n${JSON.stringify({ type: 'done', result })}\n` });
    }
    if (capture && (p === '/api/capture' || (p.startsWith('/api/capture/') && p !== '/api/capture/playlist' && p !== '/api/capture/discover'))) return capture(route, p, body(), net, now, json);
    if (p === '/api/jobs' && m === 'GET') return json(route, { ok: true, jobs: net.jobs.filter(j => !j.done).map(j => ({ id: j.id, operation: j.op, current: 1, total: j.total, currentLabel: '', okCount: 1, fallbackCount: 0, errorCount: 0, startedAt: Date.now(), updatedAt: Date.now(), status: 'running', summary: null })) });
    if (p === '/api/jobs' && m === 'POST') { const id = `job-${net.jobs.length + 1}`; net.jobs.push({ id, at: now(), op: body().operation, total: body().total, done: false }); return json(route, { ok: true, id }); }
    if (p.startsWith('/api/jobs/') && m === 'DELETE') { const j = net.jobs.find(x => x.id === p.split('/').pop()); if (j) { j.done = true; j.doneAt = now(); } return json(route, { ok: true }); }
    if (p.startsWith('/api/jobs/')) return json(route, { ok: true });
    if (p === '/api/todo') return json(route, { items: [] });
    return json(route, {});
  });
  await page.route('**/__audit', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${remote ? origin.replace('127.0.0.1', '127.0.0.2') : origin}/__audit`);
  await page.getByRole('button', { name: 'Capturer' }).first().waitFor({ timeout: 30_000 });
  return { ctx, page, net, now };
}

// UI drivers ---------------------------------------------------------------------------------------------------
export async function minimizeIfBlocking(page) { const red = page.locator('button:has-text("Réduire")'); if (await red.count()) { await red.first().click(); await page.waitForTimeout(150); } }
export async function waitBatchModalAndMinimize(page) { const red = page.locator('button:has-text("Réduire")'); await red.first().waitFor({ timeout: 15_000 }); await red.first().click(); await page.waitForTimeout(150); }
export async function submitPlaylist(page, id, { confirm = true } = {}) {
  await minimizeIfBlocking(page);
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('textarea').fill(`https://www.youtube.com/playlist?list=${id}`);
  await page.locator('.modal-box').getByRole('button', { name: 'Capturer' }).click();
  const btn = page.getByRole('button', { name: /^Importer \d+ vidéos?/ });
  await btn.waitFor({ timeout: 20_000 });
  if (confirm) await btn.click();
  return btn;
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms = 30_000, step = 100) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); } return false; }

// Records every toast-like message that appears in the DOM (the app's own feedback to the user).
export async function installToastSpy(page) {
  await page.evaluate(() => {
    window.__toasts = []; const re = /(Ajouté à la file[^\n]*|File pleine[^\n]*|File terminée[^\n]*|Import annulé[^\n]*|Playlist importée[^\n]*|⚠ [^\n]*interrompu[^\n]*|Erreur[^\n]*)/g; const t0 = performance.now();
    new MutationObserver(() => { for (const m of document.body.innerText.matchAll(re)) { const k = m[1].trim(); if (!window.__toasts.some(x => x.text === k)) window.__toasts.push({ at: Math.round(performance.now() - t0), text: k }); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}
export const toasts = (page) => page.evaluate(() => window.__toasts ?? []);
export function overlaps(jobs) { const out = []; for (let i = 0; i < jobs.length; i++) for (let j = i + 1; j < jobs.length; j++) { const a = jobs[i], b = jobs[j]; const aEnd = a.doneAt ?? Infinity, bEnd = b.doneAt ?? Infinity; if (a.at < bEnd && b.at < aEnd) out.push([a.id, b.id]); } return out; }

export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, release: () => resolve() }; }
