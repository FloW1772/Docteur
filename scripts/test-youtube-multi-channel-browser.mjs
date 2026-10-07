// YouTube Multi-Channel V1 — REAL src/App.tsx in Chromium. /api/capture/discover/channels/** is served by the REAL queue
// module (cortex-server/src/lib/youtube-channel-queue.js) running in this process with a FAKE discover (no yt-dlp, no network);
// every other /api/** call is mocked by the audit harness (no real server, no real DB).
// Usage: node scripts/test-youtube-multi-channel-browser.mjs
import assert from 'node:assert/strict';
import { startHarness, openApp, until } from './audit-queue-lib.mjs';
import { createChannelDiscoveryQueue } from '../cortex-server/src/lib/youtube-channel-queue.js';

let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };

// ─── fake discovery: per-handle plans, real abort semantics, peak concurrency recorded ─────────────────────────────
const plans = new Map(); // handle → { items, ms, fail, hang }
const fake = { active: 0, peak: 0, calls: [] };
function fakeDiscover(input, { signal, onEvent }) {
  const handle = /@([^/]+)/.exec(input)?.[1]?.toLowerCase() ?? 'x';
  const plan = plans.get(handle) ?? { items: 2, ms: 600 };
  fake.calls.push(handle);
  fake.active += 1; fake.peak = Math.max(fake.peak, fake.active);
  return new Promise(resolve => {
    let done = false;
    const end = (value) => { if (done) return; done = true; fake.active -= 1; resolve(value); };
    onEvent({ type: 'start' });
    onEvent({ type: 'mode', mode: 'CHANNEL_ALL_MEDIA', sources: ['videos', 'shorts', 'streams'], handle: `@${handle}` });
    onEvent({ type: 'phase_start', tab: 'videos', index: 0, total: 3 });
    onEvent({ type: 'progress', tab: 'videos', pages: 1, count: 0, total: 0 });
    signal.addEventListener('abort', () => setTimeout(() => end({ status: 'cancelled', items: [] }), 80), { once: true }); // "tree kill" delay
    if (plan.hang) return;
    setTimeout(() => {
      if (plan.fail) { end({ status: 'error', code: 'YTDLP_ERROR', message: plan.fail, items: [] }); return; }
      const items = Array.from({ length: plan.items }, (_, i) => ({ id: `${handle}${i}`.padEnd(11, 'x').slice(0, 11), title: `${handle} vidéo ${i + 1}`, url: `https://www.youtube.com/watch?v=${handle}${i}`, sourceTab: 'videos', mediaType: 'VIDEO' }));
      onEvent({ type: 'phase_done', tab: 'videos', count: items.length, available: true, pages: 1, total: items.length });
      onEvent({ type: 'phase_done', tab: 'shorts', count: 0, available: false, pages: 0, total: items.length });
      onEvent({ type: 'phase_done', tab: 'streams', count: 0, available: false, pages: 0, total: items.length });
      end({ status: 'done', mode: 'CHANNEL_ALL_MEDIA', items, counts: { videos: items.length }, duplicates: 0, durationMs: plan.ms, channel: { handle: `@${handle}`, url: `https://www.youtube.com/@${handle}`, title: `Chaîne ${handle}`, uploader: `Chaîne ${handle}`, id: `UC${handle}` } });
    }, plan.ms);
  });
}
const queue = createChannelDiscoveryQueue({ discover: fakeDiscover, concurrency: 2 });
const api = { calls: [], forceLost: false };

async function channelRoutes({ route, p, m, body, json }) {
  // the generic harness answers {} here; the app expects an array (otherwise "outputs is not iterable" at every page load)
  if (p === '/api/agents/pending-outputs') { await json(route, []); return true; }
  if (p === '/api/capture/discover') { api.calls.push(`${m} ${p} ${body()?.input ?? ''}`); return false; } // harness single-URL mock answers
  if (p.startsWith('/api/capture/deep') || p === '/api/capture') { api.calls.push(`${m} ${p}`); return false; }
  if (!p.startsWith('/api/capture/discover/channels')) return false;
  api.calls.push(`${m} ${p}`);
  const reply = (r) => (r?.error ? json(route, { error: r.error.code }, r.error.status) : json(route, r));
  const parts = p.split('/').slice(5); // [batchId, 'jobs', jobId, action] | [batchId, 'cancel']
  if (m === 'POST' && parts.length === 0) {
    let snap;
    try { snap = queue.createBatch(body()?.text ?? ''); } catch (err) { await json(route, { error: err.code, message: err.message }, 400); return true; }
    await reply(snap); return true;
  }
  const [batchId, a, jobId, action] = parts;
  if (m === 'GET' && parts.length === 1) { if (api.forceLost) await json(route, { error: 'BATCH_NOT_FOUND' }, 404); else await reply(queue.getBatch(batchId)); return true; }
  if (m === 'POST' && a === 'cancel') { await reply(queue.cancelBatch(batchId)); return true; }
  if (m === 'GET' && action === 'items') { await reply(queue.getJobResult(batchId, jobId)); return true; }
  if (m === 'POST' && action === 'cancel') { await reply(queue.cancelJob(batchId, jobId)); return true; }
  if (m === 'POST' && action === 'retry') { await reply(queue.retryJob(batchId, jobId)); return true; }
  await json(route, { error: 'NOPE' }, 404); return true;
}

const h = await startHarness({ port: 5237 });
const open = () => openApp(h, { playlists: {}, extra: channelRoutes, indexMs: 30 });
const panel = (page) => page.locator('[data-testid="yt-multi-panel"]');
const row = (page, line) => page.locator(`[data-testid="yt-multi-job"][data-line="${line}"]`);
const rowStatus = (page, line) => row(page, line).getAttribute('data-job-status');
async function typeCapture(page, text) {
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('textarea').fill(text);
}
const submitModal = (page) => page.locator('.modal-box').getByRole('button', { name: /Capturer|Analyse profonde/ }).click();

try {
  // ═══ S1 — modal: hint, no deep/batch article labelling ═══
  const app = await open();
  const { page, net } = app;
  plans.set('ok1', { items: 3, ms: 900 }); plans.set('ok2', { items: 2, ms: 900 }); plans.set('ok3', { items: 4, ms: 900 });
  plans.set('broken', { fail: 'Chaîne introuvable ou privée', ms: 400 }); plans.set('slow', { hang: true });
  const paste = [
    'https://www.youtube.com/@ok1', '  https://www.youtube.com/@slow  ', '', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'youtube.com/@OK1/', 'https://youtube.com/@broken', 'https://www.youtube.com/@ok2', 'https://www.youtube.com/@ok3',
  ].join('\n');
  await typeCapture(page, paste);
  const hint = await page.locator('[data-testid="capture-youtube-multi"]').innerText();
  check(/^5 chaînes YouTube détectées — découverte en file/.test(hint), `hint: ${hint}`);
  check(/1 ligne invalide/.test(hint) && /1 doublon ignoré/.test(hint), `hint counts: ${hint}`);
  eq(await page.locator('[data-testid="capture-youtube-mode"]').count(), 0, 'no single-channel hint');
  check(!(await page.locator('.modal-box').innerText()).includes('PROFONDE'), 'not labelled as a deep multi-URL capture');
  check(!/liens détectés/.test(await page.locator('.modal-box').innerText()), 'not labelled as an article URL batch');

  // ═══ S2 — queue: per-line rows, individual validation, dedup, concurrency, failure isolation, individual cancel ═══
  await submitModal(page);
  await panel(page).waitFor({ timeout: 10_000 });
  eq(await page.locator('[data-testid="yt-multi-job"]').count(), 7, 'one row per non-empty line');
  eq(await rowStatus(page, 3), 'FAILED', 'video URL line is FAILED on its own');
  check(/Pas une URL de chaîne/.test(await row(page, 3).innerText()), 'its own error is shown');
  eq(await rowStatus(page, 4), 'DUPLICATE', 'youtube.com/@OK1/ = duplicate of line 1');
  check(/ligne 1/.test(await row(page, 4).innerText()));
  eq(await page.locator('[data-testid="yt-multi-cancel-all"]').count(), 1, '"Annuler tout" available while active');

  // @slow (line 2) hangs → cancel it individually once it is RUNNING
  check(await until(async () => (await rowStatus(page, 2)) === 'RUNNING', 10_000), '@slow running');
  await row(page, 2).locator('[data-testid="yt-multi-job-cancel"]').click();
  check(await until(async () => (await rowStatus(page, 2)) === 'CANCELLED', 5_000), '@slow cancelled individually');
  check(await until(async () => !(await panel(page).getAttribute('data-active') === 'true'), 20_000), 'batch finished');
  eq(await rowStatus(page, 1), 'COMPLETED'); eq(await rowStatus(page, 5), 'FAILED'); eq(await rowStatus(page, 6), 'COMPLETED'); eq(await rowStatus(page, 7), 'COMPLETED');
  check(/Chaîne introuvable ou privée/.test(await row(page, 5).innerText()), 'yt-dlp error shown on its line only');
  eq(fake.peak, 2, 'never more than 2 discoveries at once');
  eq(fake.calls.filter(c => c === 'ok1').length, 1, 'duplicate channel discovered once');
  const summary = await page.locator('[data-testid="yt-multi-summary"]').innerText();
  check(/^3 \/ 6 terminées · 2 erreurs · 1 annulée · 1 doublon ignoré$/.test(summary), `global summary: ${summary}`);
  eq(await panel(page).getAttribute('data-tone'), 'partial', 'isolated errors are not a global failure');
  check(/^Terminé : 3 chaînes OK/.test(await page.locator('[data-testid="yt-multi-headline"]').innerText()));
  check(!api.calls.some(c => c.startsWith('POST /api/capture/discover ') || c.startsWith('POST /api/capture/deep') || c === 'POST /api/capture'), `no single-URL / deep / article call: ${api.calls.filter(c => !c.includes('/channels')).join(', ')}`);
  eq(await row(page, 3).locator('[data-testid="yt-multi-job-retry"]').count(), 0, 'an invalid line cannot be retried');
  eq(await row(page, 1).locator('[data-testid="yt-multi-job-cancel"]').count(), 0, 'no cancel after completion');

  // ═══ S3 — grouped results: each channel shows ITS items, display paging ═══
  await row(page, 1).locator('[data-testid="yt-multi-job-results"]').click();
  await row(page, 1).locator('[data-testid="yt-multi-job-items"] li').first().waitFor({ timeout: 5_000 });
  const ok1Items = await row(page, 1).locator('[data-testid="yt-multi-job-items"] li').allInnerTexts();
  eq(ok1Items.length, 3); check(ok1Items.every(t => t.startsWith('ok1 vidéo')), `ok1 items only: ${ok1Items}`);
  await row(page, 7).locator('[data-testid="yt-multi-job-results"]').click();
  await row(page, 7).locator('[data-testid="yt-multi-job-items"] li').first().waitFor({ timeout: 5_000 });
  check((await row(page, 7).locator('[data-testid="yt-multi-job-items"] li').allInnerTexts()).every(t => t.startsWith('ok3 vidéo')), 'ok3 items only');

  // ═══ S4 — retry only the cancelled channel; completed ones are not redone ═══
  plans.set('slow', { items: 1, ms: 300 });
  const callsBefore = fake.calls.length;
  await row(page, 2).locator('[data-testid="yt-multi-job-retry"]').click();
  check(await until(async () => (await rowStatus(page, 2)) === 'COMPLETED', 10_000), 'retried channel completes');
  eq(fake.calls.length, callsBefore + 1, 'only the retried channel ran again');
  eq(fake.calls.at(-1), 'slow');

  // ═══ S5 — import ONE channel through the existing import path (channel neuron + video neurons) ═══
  const savesBefore = net.saves.length;
  await row(page, 6).locator('[data-testid="yt-multi-job-import"]').click();
  check(await until(() => new Set(net.saves.slice(savesBefore).filter(s => s.kind === 'video').map(s => s.url)).size >= 2, 15_000), 'ok2 videos saved (2 distinct videos, not 2 save calls)');
  const imported = net.saves.slice(savesBefore);
  check(imported.some(s => s.kind === 'channel' && s.url === 'https://www.youtube.com/@ok2'), 'channel neuron for ok2');
  check(imported.filter(s => s.kind === 'video').every(s => /ok2/.test(s.url)), 'only ok2 videos imported');
  check(await until(async () => /Importée/.test(await row(page, 6).locator('[data-testid="yt-multi-job-import"]').innerText()), 5_000), 'marked imported');

  // ═══ S5b — import SEVERAL channels at once ("Tout importer"): one channel neuron per channel, each with ITS videos ═══
  const allBtn = page.locator('[data-testid="yt-multi-import-all"]');
  check(/les 3 chaînes terminées/.test(await allBtn.innerText()), `import-all offers the 3 not-yet-imported channels: ${await allBtn.innerText()}`);
  const savesBeforeAll = net.saves.length;
  // ok2 (imported in S5) may still be RE-SAVED by its own deferred saves; a second IMPORT would create NEW neuron ids
  const ok2Ids = new Set(net.saves.filter(s => (s.url ?? '').includes('ok2')).map(s => s.id));
  const importStart = Date.now();
  await allBtn.click();
  const expected = { ok1: 3, ok3: 4, slow: 1 };
  const consoleErrors = []; page.on("console", msg => { if (msg.type() === "error" || msg.type() === "warning") consoleErrors.push(msg.text().slice(0, 160)); });
  const savedSummary = () => JSON.stringify({ saved: net.saves.slice(savesBeforeAll).map(s => `${s.kind}:${s.url}`).filter((v, i, a) => a.indexOf(v) === i), pageErrors: net.errors, consoleErrors });
  check(await until(() => Object.entries(expected).every(([hnd, n]) => new Set(net.saves.slice(savesBeforeAll).filter(s => s.kind === 'video' && s.url.includes(`v=${hnd}`)).map(s => s.url)).size === n), 120_000), `all videos of the 3 channels saved: ${savedSummary()}`);
  console.log(`multi import of 3 channels / 8 videos took ${Math.round((Date.now() - importStart) / 1000)} s`);
  const allSaves = net.saves.slice(savesBeforeAll);
  for (const hnd of Object.keys(expected)) check(allSaves.some(s => s.kind === 'channel' && s.url === `https://www.youtube.com/@${hnd}`), `channel neuron for ${hnd}`);
  check(allSaves.filter(s => (s.url ?? '').includes('ok2')).every(s => ok2Ids.has(s.id)), 'the already imported channel is not imported twice (no new ok2 neuron)');
  eq(new Set(allSaves.filter(s => s.kind === 'video' && /v=(ok1|ok3|slow)/.test(s.url)).map(s => s.url)).size, 8, 'exactly 3 + 4 + 1 videos');
  check(allSaves.filter(s => s.kind === 'video').every(s => /v=(ok1|ok2|ok3|slow)/.test(s.url)), 'no foreign video');
  check(await until(async () => (await page.locator('[data-testid="yt-multi-import-all"]').count()) === 0, 5_000), 'nothing left to import');
  eq(await page.locator('[data-testid="yt-multi-job-import"]:has-text("Importée")').count(), 4, 'four channels marked imported');

  // ═══ S6 — reload: the panel re-attaches to the same server batch ═══
  await page.reload();
  await page.getByRole('button', { name: 'Capturer' }).first().waitFor({ timeout: 30_000 });
  check(await until(async () => (await panel(page).count()) === 1, 10_000), 'panel back after reload');
  eq(await page.locator('[data-testid="yt-multi-job"]').count(), 7);
  await page.locator('[data-testid="yt-multi-close"]').click();
  eq(await panel(page).count(), 0, 'closed');

  // ═══ S7 — cancel all while running + reduce/expand ═══
  for (const hnd of ['h1', 'h2', 'h3']) plans.set(hnd, { hang: true });
  await typeCapture(page, 'https://www.youtube.com/@h1\nhttps://www.youtube.com/@h2\nhttps://www.youtube.com/@h3');
  await submitModal(page);
  await panel(page).waitFor({ timeout: 10_000 });
  check(await until(async () => (await rowStatus(page, 1)) === 'RUNNING' && (await rowStatus(page, 2)) === 'RUNNING', 10_000), 'two running');
  eq(await rowStatus(page, 3), 'QUEUED', 'third waits for a slot');
  await page.locator('[data-testid="yt-multi-reduce"]').click();
  eq(await page.locator('[data-testid="yt-multi-jobs"]').count(), 0, 'reduced: rows hidden, queue untouched');
  await page.locator('[data-testid="yt-multi-reduce"]').click();
  await page.locator('[data-testid="yt-multi-cancel-all"]').click();
  check(await until(async () => (await panel(page).getAttribute('data-active')) === 'false', 10_000), 'all cancelled');
  eq(await page.locator('[data-job-status="CANCELLED"]').count(), 3);
  check(await until(() => fake.active === 0, 5_000), 'every fake discovery settled (no orphan)');
  eq(queue.runningCount(), 0, 'queue slots all released');
  await page.locator('[data-testid="yt-multi-close"]').click();

  // ═══ S8 — server lost the batch (restart): explicit message, panel closable, no frozen screen ═══
  plans.set('lost', { hang: true });
  await typeCapture(page, 'https://www.youtube.com/@lost\nhttps://www.youtube.com/@lost2');
  await submitModal(page);
  await panel(page).waitFor({ timeout: 10_000 });
  const lostBatchId = await page.evaluate(() => sessionStorage.getItem('docteur.youtube.channelBatch'));
  check(Boolean(lostBatchId), 'batch id remembered for re-attachment');
  api.forceLost = true;
  check(await until(async () => (await page.locator('[data-testid="yt-multi-lost"]').count()) === 1, 10_000), 'lost message');
  eq(await page.locator('[data-testid="yt-multi-job-cancel"]').count(), 0, 'no action on a lost batch');
  await page.locator('[data-testid="yt-multi-close"]').click();
  eq(await panel(page).count(), 0, 'closable');
  eq(await page.evaluate(() => sessionStorage.getItem('docteur.youtube.channelBatch')), null, 'closing forgets the batch id');
  api.forceLost = false;
  queue.cancelBatch(lostBatchId); // test cleanup of the "lost" (still hanging) fake discoveries

  // ═══ S9 — single URL: historical flow untouched (single-URL route + single panel), never the queue ═══
  const channelCallsBefore = api.calls.filter(c => c.includes('/channels')).length;
  await typeCapture(page, 'https://www.youtube.com/@single');
  eq(await page.locator('[data-testid="capture-youtube-multi"]').count(), 0, 'no multi hint for one URL');
  eq(await page.locator('[data-testid="capture-youtube-mode"]').count(), 1, 'single-channel hint shown as before');
  await submitModal(page);
  check(await until(() => api.calls.some(c => c === 'POST /api/capture/discover https://www.youtube.com/@single'), 10_000), 'single-URL route called');
  check(await until(async () => (await page.locator('[data-testid="yt-discovery-panel"]').count()) === 1, 10_000), 'single discovery panel');
  eq(api.calls.filter(c => c.includes('/channels')).length, channelCallsBefore, 'queue not used for one URL');

  eq(net.errors.length, 0, `no page error: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, 'no external request');
  await app.ctx.close();
  console.log(`YOUTUBE MULTI-CHANNEL BROWSER: PASS (${assertions} assertions, peak concurrency ${fake.peak})`);
} finally {
  await queue.close().catch(() => {});
  await h.browser.close().catch(() => {});
  await h.server.close().catch(() => {});
}
