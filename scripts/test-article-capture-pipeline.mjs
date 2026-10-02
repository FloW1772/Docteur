import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import {
  assessArticleQuality,
  closeDeepCaptureBrowserForTests,
  extractArticleCandidatesFromHtml,
  extractArticleFromHtml,
  extractWithPlaywright,
} from '../cortex-server/src/lib/deep-capture.js';

const vite = await createServer({
  configFile: false,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  logLevel: 'error',
});
const {
  CapturePipelineError,
  DEEP_CAPTURE_TIMEOUT_MS,
  persistCapturedArticle,
} = await vite.ssrLoadModule('/src/lib/capturePipeline.ts');

const fixtureText = Array.from({ length: 45 }, (_, index) =>
  `Paragraphe ${index + 1}. Cette fixture locale décrit un article complet avec des faits, des dates, des exemples et une conclusion vérifiable.`
).join(' ');
const fixtureHtml = `<!doctype html><html><head><title>Article fixture</title></head><body><main><article><h1>Audit local</h1><p>${fixtureText}</p></article></main></body></html>`;

test.after(async () => {
  await closeDeepCaptureBrowserForTests();
  await vite.close();
});

test('local article fixture: extract -> save exactly once -> index -> retrieve -> READY', async () => {
  const extracted = extractArticleFromHtml(fixtureHtml, 'https://example.com/article');
  assert.ok(extracted);
  assert.equal(extracted.title, 'Audit local');
  assert.ok(extracted.text.split(/\s+/).length > 200);

  const database = new Map();
  const vectorIndex = new Map();
  const states = [];
  const page = { id: 'fixture-article-1', title: extracted.title, content: extracted.text, status: 'EXTRACTED' };

  const ready = await persistCapturedArticle({
    createPersisted: async () => {
      assert.equal(database.has(page.id), false);
      const saved = { ...page, status: 'INDEXING' };
      database.set(page.id, saved);
      return saved;
    },
    index: async saved => {
      vectorIndex.set(saved.id, { id: saved.id, text: saved.content });
    },
    persistStatus: async (saved, status, error) => {
      const updated = { ...saved, status, error };
      database.set(saved.id, updated);
      return updated;
    },
    onState: state => states.push(state),
  });

  assert.equal(database.size, 1);
  assert.equal(vectorIndex.size, 1);
  assert.equal(vectorIndex.get(ready.id)?.id, ready.id);
  assert.equal(database.get(ready.id)?.status, 'READY');
  assert.deepEqual(states, ['SAVING', 'INDEXING', 'READY']);
  assert.ok(DEEP_CAPTURE_TIMEOUT_MS > 143_000);
});

test('JSON-LD NewsArticle: articleBody wins, metadata and hero image are preserved', () => {
  const body = Array.from({ length: 12 }, (_, i) =>
    `Paragraphe ${i + 1}. Cette actualité structurée contient des faits vérifiables, des dates précises et suffisamment de contexte pour une extraction complète.`
  ).join('\n\n');
  const html = `<!doctype html><html><head><title>Shell</title><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Titre JSON-LD', articleBody: body,
    author: { '@type': 'Person', name: 'Alice Exemple' }, datePublished: '2026-09-30',
    image: { contentUrl: 'https://images.example.com/1200x800-hero.jpg' },
  })}</script></head><body><main><p>Résumé très court.</p></main></body></html>`;
  const inspected = extractArticleCandidatesFromHtml(html, 'https://example.com/news');
  assert.equal(inspected.best?.source, 'json-ld');
  assert.equal(inspected.best?.quality.complete, true);
  assert.equal(inspected.best?.title, 'Titre JSON-LD');
  assert.equal(inspected.best?.author, 'Alice Exemple');
  assert.deepEqual(inspected.best?.imageUrls, ['https://images.example.com/1200x800-hero.jpg']);
});

test('JSON-LD @graph (MSN-like shell) is discovered without site-specific selectors', () => {
  const body = Array.from({ length: 10 }, (_, i) => `Section ${i + 1}. Le contenu chargé par le portail décrit une information complète avec contexte, citation, chronologie et conséquences détaillées.`).join('\n\n');
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@graph': [
    { '@type': 'WebSite', name: 'Portail' },
    { '@type': ['NewsArticle', 'Article'], headline: 'Actualité du portail', articleBody: body },
  ] })}</script></head><body><div id="root">Chargement…</div></body></html>`;
  const extracted = extractArticleFromHtml(html, 'https://example.com/portal/story');
  assert.equal(extracted?.source, 'json-ld');
  assert.equal(extracted?.title, 'Actualité du portail');
});

test('Readability / Wikipedia-like fixtures remain complete', () => {
  const paragraphs = Array.from({ length: 14 }, (_, i) => `<p>Section encyclopédique ${i + 1}. Ce passage présente le sujet, son historique, plusieurs références, des exemples concrets et une conclusion documentée.</p>`).join('');
  const html = `<html><head><title>Entrée encyclopédique</title></head><body><main id="content"><h1>Sujet local</h1><div class="mw-parser-output">${paragraphs}</div></main></body></html>`;
  const extracted = extractArticleFromHtml(html, 'https://fr.wikipedia.org/wiki/Fixture_locale');
  assert.ok(extracted);
  assert.equal(extracted.quality.complete, true);
  assert.ok(['readability', 'semantic-dom'].includes(extracted.source));
});

test('quality gate rejects a ~180-character teaser as a complete article', () => {
  const teaser = 'Cette brève annonce un événement sans donner le contexte, les faits, les citations ni les explications attendues dans le corps complet de l’article publié.';
  const html = `<html><head><title>Teaser</title></head><body><article><h1>Teaser</h1><p>${teaser}</p></article></body></html>`;
  const inspected = extractArticleCandidatesFromHtml(html, 'https://example.com/teaser');
  assert.equal(extractArticleFromHtml(html, 'https://example.com/teaser'), null);
  assert.equal(inspected.best?.quality.complete, false);
  assert.equal(inspected.metrics.qualityStatus, 'PARTIAL_EXTRACTION');
  assert.ok(inspected.best.quality.chars < 500);
  assert.equal(assessArticleQuality(teaser, { semantic: true }).complete, false);
});

test('Playwright fallback waits for useful rendered content and then passes the same quality gate', async () => {
  const body = Array.from({ length: 12 }, (_, i) => `Partie ${i + 1}. Le rendu JavaScript apporte le texte principal, les faits utiles, les explications nécessaires et plusieurs éléments de contexte.`).join(' ');
  const html = `<html><head><title>Rendu dynamique</title></head><body><main>Chargement…</main><script>setTimeout(() => { document.querySelector('main').innerHTML = '<article><h1>Dynamique</h1><p>${body}</p></article>'; }, 150);</script></body></html>`;
  const rendered = await extractWithPlaywright(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  assert.equal(rendered?.quality.complete, true);
  assert.match(rendered?.source ?? '', /^playwright-/);
  assert.ok((rendered?.waitMs ?? 0) >= 0);
  assert.ok((rendered?.quality.words ?? 0) >= 90);
});

test('save failure is visible and never reports fake success', async () => {
  const states = [];
  await assert.rejects(
    persistCapturedArticle({
      createPersisted: async () => { throw new Error('sqlite unavailable'); },
      index: async () => { assert.fail('index must not run'); },
      persistStatus: async value => value,
      onState: state => states.push(state),
    }),
    error => error instanceof CapturePipelineError && error.code === 'SAVE_FAILED',
  );
  assert.deepEqual(states, ['SAVING', 'FAILED']);
});

test('index failure keeps one persisted retryable article with INDEX_FAILED', async () => {
  const database = new Map();
  const states = [];
  const page = { id: 'fixture-index-failure', status: 'EXTRACTED' };

  await assert.rejects(
    persistCapturedArticle({
      createPersisted: async () => {
        const saved = { ...page, status: 'INDEXING' };
        database.set(page.id, saved);
        return saved;
      },
      index: async () => { throw new Error('embedding unavailable'); },
      persistStatus: async (saved, status, error) => {
        const updated = { ...saved, status, error };
        database.set(saved.id, updated);
        return updated;
      },
      onState: state => states.push(state),
    }),
    error => error instanceof CapturePipelineError && error.code === 'INDEX_FAILED',
  );

  assert.equal(database.size, 1);
  assert.equal(database.get(page.id)?.status, 'INDEX_FAILED');
  assert.match(database.get(page.id)?.error, /embedding unavailable/);
  assert.deepEqual(states, ['SAVING', 'INDEXING', 'FAILED']);
});
