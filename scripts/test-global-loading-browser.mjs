// Global Loading V1 — browser suite (real primitives + real wired modals, mocked /api/**,
// external network aborted). Long thresholds of the real policies are reached with
// Playwright's fake clock. Usage: node scripts/test-global-loading-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };
const SLOW = 'Plus long que prévu — l’opération continue.';

const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/global-loading-harness.jsx");mount();</script>';
const PORT = 5241;
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-global-loading', plugins: [react()], optimizeDeps: { entries: ['scripts/global-loading-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };

/**
 * Opens one harness view. `api(path, method, body)` returns:
 *   { status, json } | { status, body, contentType } | 'hold' (the test answers later via `held`).
 */
async function open(view, { api = () => ({ status: 200, json: {} }), clock = false, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  const calls = [];
  const held = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => r.abort());
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ path: url.pathname, method: req.method(), body });
    const answer = await api(url.pathname, req.method(), body);
    const reply = async (a) => {
      try {
        if (a.json !== undefined) await route.fulfill({ status: a.status ?? 200, contentType: 'application/json', headers: cors, body: JSON.stringify(a.json) });
        else await route.fulfill({ status: a.status ?? 200, contentType: a.contentType ?? 'application/octet-stream', headers: cors, body: a.body ?? '' });
      } catch { /* request already aborted by the page */ }
    };
    if (answer === 'hold') { held.push({ path: url.pathname, reply }); return undefined; }
    return reply(answer);
  });
  await page.route('**/__gl*', r => r.fulfill({ contentType: 'text/html', body: html }));
  if (clock) await page.clock.install();
  await page.goto(`http://127.0.0.1:${PORT}/__gl?view=${view}`);
  return { ctx, page, errors, calls, held };
}

const until = async (fn, ms = 10_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
const status = (page) => page.getByTestId('status').innerText();
const job = (page, index, code) => page.evaluate(([i, c]) => { const j = window.__lab.jobs[i]; return new Function('j', c)(j); }, [index, code]);
const jobCount = (page) => page.evaluate(() => window.__lab.jobs.length);

try {
  // ── 1. Lab: unknown → known progress, step, slow, elapsed outside the live region ──
  {
    const { ctx, page, errors } = await open('lab');
    await page.click('#start');
    const group = page.locator('[data-operation-status="running"]').first();
    await group.waitFor();
    eq(await group.getAttribute('aria-busy'), 'true', 'aria-busy while running');
    const bar = group.getByRole('progressbar');
    eq(await bar.getAttribute('aria-valuenow'), null, 'unknown progress: no aria-valuenow');
    eq(await bar.getAttribute('aria-valuetext'), 'En cours, durée inconnue');
    ok((await group.innerText()).includes('Démarrage…'), 'initial step shown');
    await job(page, 0, "j.setStep('Étape 2 sur 4'); j.setProgress({ current: 1, total: 4, unit: 'fichiers' });");
    ok(await until(async () => (await bar.getAttribute('aria-valuenow')) === '25'), 'known progress: aria-valuenow 25');
    eq(await bar.getAttribute('aria-valuetext'), '1 sur 4 fichiers (25 %)');
    eq(await group.locator('[aria-live="polite"]').innerText(), 'Étape 2 sur 4', 'step in the polite live region');
    ok(await until(async () => (await group.innerText()).includes(SLOW)), 'slow notice after the threshold');
    ok((await group.locator('[aria-live="polite"]').innerText()).includes(SLOW), 'slow notice is announced');
    eq(await group.locator('[aria-live] .dl-op-elapsed').count(), 0, 'elapsed time is not inside a live region');
    ok(/Écoulé : \d+ s/.test(await group.locator('.dl-op-elapsed').innerText()), 'elapsed time shown');
    const line = page.getByTestId('line').locator('[role="status"]');
    eq(await line.getAttribute('aria-live'), 'polite', 'local spinner announced politely');
    eq(await line.locator('.dl-loading-meta').getAttribute('aria-live'), 'off', 'local elapsed excluded from announcements');

    // Cancel with the keyboard: the AbortSignal really fires, a late result is ignored.
    await group.getByRole('button', { name: /Annuler/ }).focus();
    await page.keyboard.press('Enter');
    ok(await until(async () => (await status(page)) === 'cancelled'), 'cancelled');
    eq(await job(page, 0, 'return j.aborted && j.signal.aborted;'), true, 'signal aborted on cancel');
    await job(page, 0, "j.resolve('late');");
    await page.waitForTimeout(150);
    eq(await status(page), 'cancelled', 'late result ignored after cancel');
    eq(await page.locator('.dl-spinner').count(), 0, 'no spinner left after cancel');

    // Retry (keyboard) → success.
    await page.getByRole('button', { name: 'Réessayer' }).focus();
    await page.keyboard.press('Enter');
    ok(await until(async () => (await jobCount(page)) === 2), 'retry started a new run');
    await job(page, 1, "j.resolve('ok');");
    ok(await until(async () => (await status(page)) === 'success'), 'retry succeeded');
    eq(JSON.stringify(await page.evaluate(() => window.__lab.results)), JSON.stringify([null, 'ok']));

    // Error → alert with the message + Retry.
    await page.click('#start');
    await until(async () => (await jobCount(page)) === 3);
    await job(page, 2, "j.reject(new Error('HTTP 503 — moteur indisponible'));");
    const alert = page.getByRole('alert').first();
    await alert.waitFor();
    ok((await alert.innerText()).includes('HTTP 503 — moteur indisponible'), 'error message shown as alert');
    ok(await page.getByRole('button', { name: 'Réessayer' }).isVisible(), 'retry offered after error');

    // Timeout → alert, late result ignored, request aborted; never an endless spinner.
    await page.click('#start');
    await until(async () => (await jobCount(page)) === 4);
    ok(await until(async () => (await status(page)) === 'timeout', 4_000), 'timeout reached');
    ok((await page.getByRole('alert').first().innerText()).includes('délai dépassé'), 'timeout explained');
    eq(await job(page, 3, 'return j.signal.aborted;'), true, 'timed-out request aborted');
    await job(page, 3, "j.resolve('too late');");
    await page.waitForTimeout(150);
    eq(await status(page), 'timeout', 'late result ignored after timeout');
    eq(await page.locator('.dl-spinner').count(), 0, 'no infinite spinner');
    // Dismiss returns to idle.
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    eq(await status(page), 'idle');
    eq(errors.length, 0, `no page errors: ${errors.join(' | ')}`);
    await ctx.close();
  }

  // ── 2. Global blocking overlay: focus in, Tab trapped, Escape cancels, focus restored ──
  {
    const { ctx, page, errors } = await open('overlay');
    await page.focus('#trigger');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Blocage test' });
    await dialog.waitFor();
    eq(await dialog.getAttribute('aria-modal'), 'true');
    ok(await page.evaluate(() => document.activeElement?.closest('.dl-overlay-box') !== null), 'focus moved into the overlay');
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
      ok(await page.evaluate(() => document.activeElement?.closest('.dl-overlay-box') !== null), `Tab #${i + 1} stays inside`);
    }
    await page.keyboard.press('Escape');
    ok(await until(async () => (await status(page)) === 'cancelled'), 'Escape cancels a cancellable global operation');
    eq(await dialog.count(), 0, 'overlay closed');
    eq(await page.evaluate(() => document.activeElement?.id), 'trigger', 'focus restored to the trigger');
    eq(await page.evaluate(() => window.__lab.jobs[0].signal.aborted), true);
    eq(errors.length, 0);
    await ctx.close();
  }

  // ── 3. Reduced motion: no spinning, text kept ──
  for (const [mode, expected] of [['reduce', 'none'], ['no-preference', 'dl-spin']]) {
    const { ctx, page } = await open('lab', { reducedMotion: mode });
    await page.click('#start');
    await page.locator('.dl-spinner').first().waitFor();
    eq(await page.locator('.dl-op .dl-spinner').evaluate(el => getComputedStyle(el).animationName), expected, `spinner animation (${mode})`);
    eq(await page.locator('.dl-bar--indeterminate .dl-bar-fill').evaluate(el => getComputedStyle(el).animationName), mode === 'reduce' ? 'none' : 'dl-indeterminate', `indeterminate bar (${mode})`);
    ok((await page.locator('.dl-op').innerText()).includes('Opération test'), 'label still visible');
    await ctx.close();
  }

  // ── 4. Image generator (real modal, real policy): step, slow at 30 s, error + retry → success ──
  {
    let generateCalls = 0;
    const { ctx, page, errors, held } = await open('image', {
      clock: true,
      api: (path, method) => {
        if (path === '/api/image-generation/providers/status') return { status: 503, json: { error: 'off' } };
        if (path === '/api/image-generation/history') return { json: { ok: true, generations: [] } };
        if (path === '/api/image-generation/generate') { generateCalls += 1; return 'hold'; }
        if (path === '/api/image-generation/gen-2') return { json: { ok: true, generation: { id: 'gen-2', image_id: 'img-2', prompt: 'Un phare', provider_used: 'comfyui', model_used: 'sdxl', width: 512, height: 512 } } };
        if (path.startsWith('/api/image/')) return { status: 200, contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') };
        return { json: {} };
      },
    });
    await page.getByPlaceholder(/.+/).first().fill('Un phare');
    await page.getByRole('button', { name: 'Générer' }).click();
    const progress = page.locator('[data-operation-status="running"]');
    await progress.waitFor();
    ok((await progress.innerText()).includes('Génération par le moteur d’images'), 'image: current step shown');
    ok(await page.getByRole('button', { name: /Génération en cours/ }).isDisabled(), 'button disabled while running');
    await page.clock.fastForward(31_000);
    ok(await until(async () => (await progress.innerText()).includes(SLOW)), 'image: slow notice after 30 s');
    ok(/Écoulé : 3\d s/.test(await progress.innerText()), 'image: elapsed ~31 s');
    await until(async () => held.length === 1);
    await held.shift().reply({ status: 503, json: { error: 'ComfyUI indisponible' } });
    const alert = page.getByRole('alert');
    await alert.waitFor();
    ok((await alert.innerText()).includes('ComfyUI indisponible'), 'image: real error shown');
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await until(async () => held.length === 1);
    eq(generateCalls, 2, 'retry re-sent the generation');
    await held.shift().reply({ json: { ok: true, generation_id: 'gen-2' } });
    await page.locator('img[alt="Un phare"]').waitFor();
    eq(await page.locator('[data-operation-status]').count(), 0, 'image: progress gone after success');

    // Network-level timeout (client 90 s): explicit end state, never an endless spinner.
    await page.getByRole('button', { name: 'Générer' }).click();
    await until(async () => held.length === 1);
    await page.clock.fastForward(91_000);
    const timeoutAlert = page.getByRole('alert');
    ok(await until(async () => (await timeoutAlert.count()) > 0 && (await timeoutAlert.innerText()).includes('délai réseau dépassé')), 'image: client timeout surfaces');
    ok((await timeoutAlert.innerText()).includes('Le serveur a peut-être terminé en arrière-plan'), 'image: says the work may have continued');
    eq(await page.locator('.dl-spinner').count(), 0, 'image: no spinner left');
    eq(errors.length, 0, `image: no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  // ── 5. Vision (local loading next to the button): slow at 20 s, then the answer ──
  {
    const { ctx, page, errors, held } = await open('vision', {
      clock: true,
      api: (path) => {
        if (path === '/api/vision/status') return { json: { model: 'llava:7b', installed: true } };
        if (path === '/api/vision/analyze') return 'hold';
        if (path.startsWith('/api/image/')) return { status: 200, contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') };
        return { json: {} };
      },
    });
    await page.locator('input, textarea').first().fill('Que voit-on ?');
    await page.getByRole('button', { name: /Analyser l'image/ }).click();
    const local = page.locator('.dl-loading[role="status"]');
    await local.waitFor();
    ok((await local.innerText()).includes('Analyse en cours'), 'vision: local spinner with step');
    await page.clock.fastForward(21_000);
    ok(await until(async () => (await local.innerText()).includes(SLOW)), 'vision: slow notice after 20 s');
    await until(async () => held.length === 1);
    await held.shift().reply({ json: { ok: true, answer: 'Un phare au crépuscule.', model_used: 'llava:7b' } });
    await page.getByText('Un phare au crépuscule.').waitFor();
    eq(await local.count(), 0, 'vision: spinner gone');
    eq(errors.length, 0);
    await ctx.close();
  }

  // ── 6. PDF export: error with retry → success downloads and closes ──
  {
    let calls = 0;
    const { ctx, page, errors } = await open('pdf', {
      api: (path) => {
        if (path === '/api/pdf/subject') { calls += 1; return calls === 1 ? { status: 500, json: { error: 'Chromium indisponible' } } : { status: 200, contentType: 'application/pdf', body: '%PDF-1.4 test' }; }
        return { json: {} };
      },
    });
    await page.getByRole('button', { name: /Télécharger le PDF/ }).click();
    const alert = page.getByRole('alert');
    await alert.waitFor();
    ok((await alert.innerText()).length > 0, 'pdf: error explained');
    await page.getByRole('button', { name: 'Réessayer' }).click();
    ok(await until(() => page.evaluate(() => window.__lab.closed === true)), 'pdf: retry succeeded and closed');
    eq(JSON.stringify(await page.evaluate(() => window.__lab.toasts)), JSON.stringify(['PDF téléchargé']));
    eq(calls, 2);
    eq(errors.length, 0);
    await ctx.close();
  }

  // ── 7. Chat: slow notice, server error shown without an automatic resend ──
  {
    const { ctx, page, errors, held, calls } = await open('chat', {
      clock: true,
      api: (path) => {
        if (path === '/api/chat/status') return { json: { model: 'm', installed: true, gpu_busy: false } };
        if (path === '/api/chat/conversations') return { json: { id: 'conv-1' } };
        if (path === '/api/chat/message') return 'hold';
        return { json: {} };
      },
    });
    const input = page.locator('textarea, input[type="text"]').last();
    await input.fill('Bonjour');
    await input.press('Enter');
    const local = page.locator('.dl-loading[role="status"]');
    await local.waitFor({ timeout: 10_000 });
    ok((await local.innerText()).includes('Docteur réfléchit…'), 'chat: thinking indicator kept');
    await page.clock.fastForward(21_000);
    ok(await until(async () => (await local.innerText()).includes(SLOW)), 'chat: slow notice after 20 s');
    await until(async () => held.length === 1);
    await held.shift().reply({ status: 500, json: { error: 'boom' } });
    await page.getByRole('alert').waitFor();
    eq(await page.getByRole('button', { name: 'Réessayer' }).count(), 0, 'chat: no automatic resend (could duplicate the message)');
    eq(calls.filter(c => c.path === '/api/chat/message').length, 1);
    eq(errors.length, 0);
    await ctx.close();
  }

  // ── 8. Backup restore: the only global blocking overlay — known progress, focus kept inside ──
  {
    const { ctx, page, errors, held } = await open('backup', {
      clock: true,
      api: (path) => {
        if (path === '/api/backup/list') return { json: { ok: true, backups: [] } };
        if (path === '/api/backup/import') return 'hold';
        return { json: {} };
      },
    });
    const backup = { version: 1, exported_at: '2026-10-06T00:00:00Z', neurons: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], links: [{ from: 'a', to: 'b' }] };
    await page.locator('input[type="file"]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    const dialog = page.getByRole('alertdialog', { name: 'Restauration du backup' });
    await dialog.waitFor();
    const bar = dialog.getByRole('progressbar');
    ok(await until(async () => (await bar.getAttribute('aria-valuenow')) === '33'), 'backup: known progress 1/3');
    ok((await dialog.innerText()).includes('Indexation de 2 neurone(s)…'), 'backup: real step');
    eq(await dialog.getByRole('button', { name: /Annuler/ }).count(), 0, 'backup: no fake cancel');
    ok(await page.evaluate(() => document.activeElement?.closest('.dl-overlay-box') !== null), 'backup: focus inside the overlay');
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.activeElement?.closest('.dl-overlay-box') !== null), 'backup: Tab cannot leave');
    await page.keyboard.press('Escape');
    ok(await dialog.isVisible(), 'backup: Escape does not interrupt a non-cancellable restore');
    await page.clock.fastForward(21_000);
    ok(await until(async () => (await dialog.innerText()).includes(SLOW)), 'backup: slow notice');
    await until(async () => held.length === 1);
    await held.shift().reply({ json: { ok: true, indexed: 2, total: 2, errors: [] } });
    ok(await until(async () => (await dialog.count()) === 0), 'backup: overlay closes on success');
    await page.getByText('2/2 neurones restaurés · 1 synapses').waitFor();
    eq(JSON.stringify(await page.evaluate(() => window.__lab.restored)), JSON.stringify([{ neurons: 2, links: 1 }]));

    // Invalid file: error inside the overlay, closed with the keyboard.
    await page.locator('input[type="file"]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":true}') });
    await dialog.waitFor();
    ok((await dialog.getByRole('alert').innerText()).includes('Format invalide'), 'backup: invalid file explained');
    await dialog.getByRole('button', { name: 'Fermer' }).focus();
    await page.keyboard.press('Enter');
    ok(await until(async () => (await dialog.count()) === 0), 'backup: error dismissed');
    eq(errors.length, 0, `backup: no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  console.log(`GLOBAL_LOADING_BROWSER_PASS assertions=${assertions}`);
} finally {
  await browser.close();
  await server.close();
}
