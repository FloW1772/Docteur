// Global Loading V1 — the REAL capture modal of App.tsx on the shared operation panel:
// step, elapsed time, "slower than expected" at 45 s, ARIA, cancel that really aborts.
// Mocked API (audit-queue harness), no real server or DB.
import assert from 'node:assert/strict';
import { startHarness, openApp, until } from './audit-queue-lib.mjs';

let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };
const SLOW = 'Plus long que prévu — l’opération continue.';

const harness = await startHarness({ port: 5243 });
try {
  let aborted = false;
  const app = await openApp(harness, {
    extra: async ({ route, p, json }) => (p === '/api/agents/pending-outputs' ? (json(route, []), true) : false),
    capture: async (route, path) => {
      if (path !== '/api/capture/deep') return route.fulfill({ status: 500, body: '{}' });
      // Held until the page aborts it (the request is never answered).
      await new Promise(resolve => { route.request().frame().page().on('requestfailed', req => { if (req.url().includes('/api/capture/deep')) { aborted = true; resolve(); } }); });
      return undefined;
    },
  });
  const { page } = app;
  await page.clock.install();
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('.modal-box textarea').fill('info https://example.com/article-lent');
  await page.locator('.modal-box').getByRole('button', { name: /Analyse profonde/ }).click();

  const panel = page.locator('.modal-box [data-operation-status="running"]');
  await panel.waitFor({ timeout: 10_000 });
  eq(await panel.getAttribute('aria-busy'), 'true', 'aria-busy');
  eq(await panel.getAttribute('aria-label'), 'Capture d’article', 'labelled group');
  ok((await panel.innerText()).includes('Récupération'), 'current phase shown');
  eq(await panel.getByRole('progressbar').getAttribute('aria-valuetext'), 'En cours, durée inconnue', 'unknown progress');

  await page.clock.fastForward(46_000);
  ok(await until(async () => (await panel.innerText()).includes(SLOW), 8_000), 'slow notice after 45 s');
  ok(await until(async () => /Écoulé : 4\d s/.test(await panel.innerText()), 8_000), 'elapsed ~46 s');
  ok((await panel.innerText()).includes('Analyse locale'), 'App phase timers still drive the step');

  const cancel = page.getByRole('button', { name: 'Annuler la capture' });
  eq(await cancel.count(), 1, 'cancel keeps its accessible name');
  await cancel.focus();
  await page.keyboard.press('Enter');
  ok(await until(async () => aborted, 8_000), 'cancel really aborts the request');
  ok(await until(async () => (await panel.count()) === 0, 8_000), 'progress panel gone after cancel');
  eq(app.net.errors.length, 0, `no page errors: ${app.net.errors.join(' | ')}`);
  eq(app.net.external.length, 0, 'no external request');
  await app.ctx.close();
  console.log(`GLOBAL_LOADING_CAPTURE_BROWSER_PASS assertions=${assertions}`);
} finally {
  await harness.browser.close();
  await harness.server.close();
}
