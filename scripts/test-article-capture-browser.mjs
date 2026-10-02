import assert from 'node:assert/strict';
import { startHarness, openApp, until } from './audit-queue-lib.mjs';

const articleResponse = {
  fallback: false,
  captureId: 'capture-fixture-1',
  parent: null,
  child: {
    title: 'Article pipeline fixture',
    kind: 'link',
    content: 'Résumé structuré de la fixture.\n\nSource : https://example.com/article',
    metadata: {
      url: 'https://example.com/article',
      deep_capture: true,
      captureId: 'capture-fixture-1',
      captureStatus: 'EXTRACTED',
    },
  },
};

async function submitArticle(page) {
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('textarea').fill('info https://example.com/article');
  await page.locator('.modal-box').getByRole('button', { name: /Capturer|Analyse profonde/ }).click();
}

const harness = await startHarness();
try {
  // Success: keep the mocked extraction open long enough to verify that the
  // active phase remains visible, then assert save -> index -> READY ordering.
  const success = await openApp(harness, {
    indexMs: 500,
    saveMs: () => 250,
    capture: async (route, path, _body, _net, _now, json) => {
      assert.equal(path, '/api/capture/deep');
      await new Promise(resolve => setTimeout(resolve, 5_300));
      return json(route, articleResponse);
    },
  });
  await submitArticle(success.page);
  await success.page.waitForTimeout(2_300);
  assert.match(await success.page.locator('.modal-box').innerText(), /Extraction de l'article/);
  await success.page.waitForTimeout(3_100);
  assert.match(await success.page.locator('.modal-box').innerText(), /Analyse locale|Enregistrement/);
  assert.ok(await until(async () => success.net.saves.some(save => save.captureStatus === 'READY'), 15_000, 100));
  const successSaves = success.net.saves.filter(save => save.captureId === 'capture-fixture-1');
  assert.equal(new Set(successSaves.map(save => save.id)).size, 1);
  assert.deepEqual(successSaves.map(save => save.captureStatus), ['INDEXING', 'READY']);
  assert.equal(success.net.index.length, 1);
  assert.ok(success.net.index[0].start >= successSaves[0].at);
  assert.ok(successSaves[1].at >= success.net.index[0].end);
  await success.page.getByText(/Terminé — article enregistré et indexé/).waitFor({ timeout: 5_000 });
  await success.ctx.close();

  // Save failure: no index request and no fake completion.
  const saveFailure = await openApp(harness, {
    saveFail: page => page.metadata?.captureStatus === 'INDEXING',
    capture: async (route, _path, _body, _net, _now, json) => json(route, articleResponse),
  });
  await submitArticle(saveFailure.page);
  await saveFailure.page.getByText(/SAVE_FAILED/).waitFor({ timeout: 8_000 });
  assert.equal(saveFailure.net.index.length, 0);
  assert.equal(saveFailure.net.saves.some(save => save.captureStatus === 'READY'), false);
  assert.ok(await saveFailure.page.locator('.modal-box').isVisible());
  await saveFailure.ctx.close();

  // Index failure: the SQLite article remains explicit and retryable.
  const indexFailure = await openApp(harness, {
    indexFail: () => true,
    capture: async (route, _path, _body, _net, _now, json) => json(route, articleResponse),
  });
  await submitArticle(indexFailure.page);
  await indexFailure.page.getByText(/INDEX_FAILED/).waitFor({ timeout: 10_000 });
  assert.equal(indexFailure.net.index.length, 1);
  assert.equal(indexFailure.net.saves.filter(save => save.captureStatus === 'INDEXING').length, 1);
  assert.equal(indexFailure.net.saves.filter(save => save.captureStatus === 'INDEX_FAILED').length, 1);
  assert.equal(indexFailure.net.saves.some(save => save.captureStatus === 'READY'), false);
  await indexFailure.ctx.close();

  // Partial extraction: preserve the simple capture, but never label it READY.
  const partial = await openApp(harness, {
    capture: async (route, path, _body, _net, _now, json) => {
      if (path === '/api/capture/deep') return json(route, {
        fallback: true,
        reason: 'partial_extraction',
        extraction: { finalChars: 180, finalWords: 29, qualityStatus: 'PARTIAL_EXTRACTION', fallbackReason: 'partial_extraction' },
      });
      return json(route, {
        parent: null,
        child: { title: 'Teaser incomplet', kind: 'link', content: 'Texte incomplet de 180 caractères.', metadata: { url: 'https://example.com/article' } },
      });
    },
  });
  await submitArticle(partial.page);
  await partial.page.getByText(/PARTIAL_EXTRACTION/).waitFor({ timeout: 8_000 });
  assert.ok(await until(async () => partial.net.saves.some(save => save.captureStatus === 'PARTIAL_EXTRACTION'), 8_000, 100));
  assert.equal(partial.net.saves.some(save => save.captureStatus === 'READY'), false);
  assert.equal(partial.net.saves.find(save => save.captureStatus === 'PARTIAL_EXTRACTION')?.fallbackReason, 'partial_extraction');
  assert.match(partial.net.saves.find(save => save.captureStatus === 'PARTIAL_EXTRACTION')?.captureWarning ?? '', /trop court|article complet/);
  await partial.ctx.close();

  console.log('ARTICLE_CAPTURE_BROWSER_PASS assertions=21');
} finally {
  await harness.browser.close();
  await harness.server.close();
}
