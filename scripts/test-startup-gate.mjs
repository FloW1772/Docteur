import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); let ready = false, probes = 0;
  const premature = [];
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/ping') {
      probes++;
      if (!ready) { await route.abort('connectionrefused'); return; }
    } else if (!ready) premature.push(route.request().url());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, pages: [], items: [], jobs: [], total: 0, byKind: {} }) });
  });
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('status').waitFor();
  await page.waitForTimeout(3500);
  assert.deepEqual(premature, []);
  assert.ok(probes >= 2);
  ready = true;
  await page.getByRole('status').waitFor({ state: 'detached', timeout: 10000 });
  console.log('PASS startup gate: retry after connection refusal, explicit status, zero application API calls before readiness', { probes });
} finally { await browser.close(); }
