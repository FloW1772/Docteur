// Article Canonical V1 — browser suite. Mounts the REAL src/App.tsx; /api/capture/deep
// is answered by the REAL canonical pipeline (cortex-server/src/lib/canonical-article.js
// + the real HTML extractor) with a scripted model and an in-memory page store that
// mirrors what the app saves. No real server, no real DB, external network aborted.
import assert from 'node:assert/strict';
import { startHarness, openApp, until } from './audit-queue-lib.mjs';
import {
  articleInputFromExtraction, canonicalizeUrl, findDuplicateArticle, runCanonicalArticleCapture,
} from '../cortex-server/src/lib/canonical-article.js';
import { extractArticleCandidatesFromHtml, closeDeepCaptureBrowserForTests } from '../cortex-server/src/lib/deep-capture.js';

let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };

const HEADLINE = 'Le télescope Vera Rubin dévoile dix millions de galaxies';
const PARAGRAPHS = Array.from({ length: 12 }, (_, i) =>
  `Paragraphe ${i + 1} : l’observatoire installé au Chili a publié des images « inédites » du ciel austral, ` +
  `avec des données vérifiables et des chiffres comme ${1200 + i} galaxies par degré carré pour la cosmologie moderne.`);
const ARTICLE_URL = 'https://www.msn.com/fr-fr/actualite/sciences/le-telescope-vera-rubin/ar-AA1vera';
const SHARED_URL = `${ARTICLE_URL}?ocid=msedgntp&cvid=4f2a`;
const OTHER_URL = 'https://www.msn.com/fr-fr/actualite/sciences/autre-sujet/ar-AA2other';
const msnHtml = (headline, paragraphs) => `<!doctype html><html><head><title>${headline} - MSN</title>
  <meta property="og:site_name" content="MSN">
  <script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline, author: { name: 'Jean Dupont' }, datePublished: '2026-10-03T08:15:00Z', articleBody: paragraphs.join('\n\n') })}</script>
  </head><body><div id="root"></div></body></html>`;
const PAGES_HTML = {
  [ARTICLE_URL]: msnHtml(HEADLINE, PARAGRAPHS),
  [OTHER_URL]: msnHtml('Un autre sujet scientifique du jour', PARAGRAPHS.map(p => p.replace('Chili', 'Japon'))),
};
const PASTED = [HEADLINE, 'Histoire de Jean Dupont', 'Publié le 03/10/2026 à 10:15', ...PARAGRAPHS].join('\n');

// ── Emulated cortex-server: same calls as server.js deepCapture/deepCaptureText ──
function makeServer(store) {
  const calls = { deep: [], analyze: 0 };
  const deps = {
    analysisPrompt: 'Analyse ce contenu',
    analyze: async () => { calls.analyze += 1; return { ok: true, response: `Synthèse scriptée n°${calls.analyze}.`, model: 'scripted-model', aiMs: 1, pairAttemptMs: 0 }; },
    generateTitle: async () => 'Titre généré',
    resolveStyle: async () => ({ block: '', usedExamples: [] }),
    personaNote: () => '',
    listPages: () => [...store.values()],
  };
  async function deep(body) {
    calls.deep.push(body);
    const checkDuplicate = body.checkDuplicate === true;
    if (body.text) {
      return runCanonicalArticleCapture({ path: 'paste', text: body.text, source: body.source, url: body.url, captureId: `cap-${calls.deep.length}`, checkDuplicate }, deps);
    }
    if (checkDuplicate) {
      const canonicalUrl = canonicalizeUrl(body.url);
      const existing = findDuplicateArticle(deps.listPages(), { canonicalUrl });
      if (existing) return { duplicate: true, fallback: false, existing, canonical: { canonicalUrl, contentHash: null, title: '' } };
    }
    const html = PAGES_HTML[canonicalizeUrl(body.url)];
    const inspected = extractArticleCandidatesFromHtml(html, body.url);
    const extraction = { fallback: false, text: inspected.best.text, fullText: inspected.best.text, title: inspected.best.title, source_type: 'web', imageUrls: [], page: inspected.page, extraction: { chosenExtractor: inspected.best.source } };
    return runCanonicalArticleCapture(articleInputFromExtraction(body.url, extraction, { captureId: `cap-${calls.deep.length}`, checkDuplicate }), deps);
  }
  return { calls, deep };
}

// 55 older neurons, so the existing article is NOT among the 50 loaded at startup.
function seedWithExistingArticle() {
  const filler = Array.from({ length: 55 }, (_, i) => ({
    id: `seed-${i}`, kind: 'note', title: `Note ${i}`, blocks: [], links: [], metadata: {}, createdAt: 10_000 + i, updatedAt: 10_000 + i,
  }));
  const existing = {
    id: 'existing-article', kind: 'link', title: HEADLINE, links: [], createdAt: 1, updatedAt: 1,
    blocks: [{ id: 'b1', type: 'paragraph', content: 'Analyse existante — à conserver.' }],
    metadata: { url: `${ARTICLE_URL}?ocid=ancien`, deep_capture: true }, // legacy capture: no canonical_article
  };
  return [existing, ...filler];
}

async function open(harness, { seedPages = [] } = {}) {
  const store = new Map(seedPages.map(p => [p.id, p]));
  const server = makeServer(store);
  const dialogs = [];
  let dialogAnswer = 'dismiss';
  const app = await openApp(harness, {
    seedPages,
    extra: async ({ route, p, m, body, json }) => {
      // The generic harness answers `{}`; the real server returns an array here.
      if (p === '/api/agents/pending-outputs') return (json(route, []), true);
      if (p.startsWith('/api/neuron/') && m === 'PUT') {
        const page = body().page;
        if (page?.id) store.set(page.id, page);
        return false; // the harness still records and answers the save
      }
      if (p.startsWith('/api/neuron/') && m === 'GET') {
        const page = store.get(decodeURIComponent(p.split('/').pop()));
        return page ? (json(route, { page }), true) : (json(route, { error: 'not found' }, 404), true);
      }
      return false;
    },
    capture: async (route, path, body, _net, _now, json) => {
      if (path === '/api/capture/deep') return json(route, await server.deep(body));
      return json(route, { error: 'unexpected' }, 500);
    },
  });
  app.page.on('dialog', async dialog => { dialogs.push(dialog.message()); await (dialogAnswer === 'accept' ? dialog.accept() : dialog.dismiss()); });
  return { ...app, store, server, dialogs, answer: (value) => { dialogAnswer = value; } };
}

async function submit(page, value) {
  await page.getByRole('button', { name: 'Capturer' }).first().click();
  await page.locator('.modal-box textarea').fill(value);
  await page.locator('.modal-box').getByRole('button', { name: /Capturer|Analyse profonde|Analyser le texte|Analyser \d+ liens/ }).click();
}

const articlePages = (store) => [...store.values()].filter(p => p.kind !== 'channel' && p.metadata?.deep_capture);
const titleValue = (page) => page.locator('textarea[placeholder="Titre du neurone"]').first().inputValue().catch(() => '');

const harness = await startHarness({ port: 5237 });
try {
  // 1. URL path then pasted MSN text of the same article: identified, existing opened, no duplicate.
  {
    const app = await open(harness);
    await submit(app.page, `info ${SHARED_URL}`);
    ok(await until(() => articlePages(app.store).some(p => p.metadata?.captureStatus === 'READY'), 20_000), 'URL capture saved READY');
    const first = articlePages(app.store)[0];
    eq(first.title, HEADLINE, 'URL path title = headline');
    eq(first.metadata.canonical_article.canonicalUrl, ARTICLE_URL, 'canonical URL stored');
    eq(first.metadata.canonical_article.author, 'Jean Dupont', 'author stored');
    eq(first.metadata.url, SHARED_URL, 'original link kept as provenance');
    eq(app.server.calls.deep[0].checkDuplicate, true, 'new capture asks for the duplicate check');
    ok([...app.store.values()].some(p => p.kind === 'channel' && p.title === 'MSN'), 'parent MSN created');
    // Snapshot once the capture has fully settled (READY + link to its parent saved).
    await app.page.getByText(/Terminé — article enregistré et indexé/).waitFor({ timeout: 8_000 });
    ok(await until(() => (app.store.get(first.id)?.links ?? []).length === 1, 8_000), 'article linked to its parent');
    await app.page.waitForTimeout(1_500);
    const firstJson = JSON.stringify(app.store.get(first.id));

    // Paste the same article (MSN text, other tracking parameter).
    app.answer('dismiss');
    await submit(app.page, `info msn ${ARTICLE_URL}?ocid=sharelink\n${PASTED}`);
    await app.page.getByText(/Article déjà présent — neurone existant ouvert/).waitFor({ timeout: 10_000 });
    eq(app.dialogs.length, 1, 'one confirmation asked');
    ok(app.dialogs[0].includes(HEADLINE) && /nouvelle version/.test(app.dialogs[0]), 'dialog names the existing article');
    eq(app.server.calls.analyze, 1, 'no model call for the duplicate');
    eq(articlePages(app.store).length, 1, 'no duplicate neuron');
    eq(JSON.stringify(app.store.get(first.id)), firstJson, 'existing neuron untouched');
    eq(await titleValue(app.page), HEADLINE, 'existing neuron opened');
    eq(app.server.calls.deep.at(-1).checkDuplicate, true);

    // 2. Same paste, user explicitly asks for a new version → second neuron, first kept.
    app.answer('accept');
    await submit(app.page, `info msn ${SHARED_URL}\n${PASTED}`);
    ok(await until(() => articlePages(app.store).filter(p => p.metadata?.captureStatus === 'READY').length === 2, 20_000), 'new version saved');
    eq(app.dialogs.length, 2);
    const last = app.server.calls.deep.at(-1);
    eq(last.checkDuplicate, undefined, 'retry without the duplicate check');
    eq(JSON.stringify(app.store.get(first.id)), firstJson, 'first neuron still untouched');
    const second = articlePages(app.store).find(p => p.id !== first.id);
    eq(second.title, first.title, 'paste path → same title');
    eq(second.metadata.canonical_article.contentHash, first.metadata.canonical_article.contentHash, 'same content hash');
    eq(second.metadata.canonical_article.canonicalUrl, first.metadata.canonical_article.canonicalUrl, 'same canonical URL');
    eq(second.metadata.pasted_text, true, 'provenance: pasted');
    eq([...app.store.values()].filter(p => p.kind === 'channel').length, 1, 'same parent reused (MSN ≡ Msn)');
    eq(app.server.calls.analyze, 2);
    eq(app.net.errors.length, 0, `no page errors: ${app.net.errors.join(' | ')}`);
    eq(app.net.external.length, 0, 'no external request');
    await app.ctx.close();
  }

  // 3. Legacy neuron outside the first 50 loaded: identified by its old link, opened on demand.
  {
    const app = await open(harness, { seedPages: seedWithExistingArticle() });
    app.answer('dismiss');
    await submit(app.page, `info ${SHARED_URL}`);
    await app.page.getByText(/Article déjà présent — neurone existant ouvert/).waitFor({ timeout: 10_000 });
    eq(app.server.calls.analyze, 0, 'identified before fetch/model');
    eq(articlePages(app.store).length, 1, 'still one article');
    ok(await until(async () => (await titleValue(app.page)) === HEADLINE, 8_000), 'unloaded neuron fetched and opened');
    eq(app.store.get('existing-article').blocks[0].content, 'Analyse existante — à conserver.', 'legacy content intact');
    await app.ctx.close();
  }

  // 4. Batch of links: duplicates are skipped without blocking prompts and reported.
  {
    const app = await open(harness, { seedPages: seedWithExistingArticle() });
    await submit(app.page, `info ${SHARED_URL}\n${OTHER_URL}`);
    await app.page.getByText(/1 analyse réussie, 1 déjà présent/).waitFor({ timeout: 30_000 });
    eq(app.dialogs.length, 0, 'no prompt during a batch');
    eq(app.server.calls.analyze, 1, 'only the new article analysed');
    eq(articlePages(app.store).length, 2, 'legacy + new one');
    await app.ctx.close();
  }

  // 5. Pasted text with no article content → explicit message, no neuron.
  {
    const app = await open(harness);
    await submit(app.page, 'info msn\n​​');
    await app.page.getByText(/Analyse impossible — aucun contenu d’article/).waitFor({ timeout: 10_000 });
    eq(app.server.calls.analyze, 0);
    eq(articlePages(app.store).length, 0);
    eq(app.net.errors.length, 0);
    await app.ctx.close();
  }

  console.log(`ARTICLE_CANONICAL_BROWSER_PASS assertions=${assertions}`);
} finally {
  await closeDeepCaptureBrowserForTests();
  await harness.browser.close();
  await harness.server.close();
}
