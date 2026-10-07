// Article Canonical V1 — "info <lien>" (URL extraction) and "info msn <lien>"
// + pasted text must converge on the same CanonicalArticle, the same analysis
// prompt and the same neuron. Pure pipeline + real HTML extractor + in-memory
// SQLite: no network, no model, no real database.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  canonicalizeUrl, normalizeArticleText, normalizeArticleTitle, resolveSourceName, toIsoDate,
  textFingerprint, contentHashOf, buildCanonicalArticle, buildArticleAnalysis, findDuplicateArticle,
  articleInputFromExtraction, runCanonicalArticleCapture,
} from './src/lib/canonical-article.js';
import { extractArticleCandidatesFromHtml, extractContent, closeDeepCaptureBrowserForTests } from './src/lib/deep-capture.js';
import { initSqlite, savePageToStore, getAllPagesMetaFromStore, getPageFromStore } from './src/lib/sqlite.js';
import { createCaptureRoute } from './src/routes/capture.js';

initSqlite(':memory:');
test.after(() => closeDeepCaptureBrowserForTests());

const PROMPT = 'Analyse ce contenu et produis en français :\n1. RÉSUMÉ';

// ── Fixture: one MSN article, seen through both paths ────────────────────────

const HEADLINE = 'Le télescope Vera Rubin dévoile dix millions de galaxies';
const PARAGRAPHS = Array.from({ length: 12 }, (_, i) =>
  `Paragraphe ${i + 1} : l’observatoire installé au Chili a publié des images « inédites » du ciel austral, ` +
  `avec des données vérifiables, des dates précises et des chiffres comme ${1200 + i} galaxies par degré carré. ` +
  `Les astronomes de Tōkyō (東京) et de São Paulo saluent une avancée majeure 🚀 pour la cosmologie.`);
const ARTICLE_URL = 'https://www.msn.com/fr-fr/actualite/sciences/le-telescope-vera-rubin/ar-AA1vera';
const SHARED_URL = `${ARTICLE_URL}?ocid=msedgntp&cvid=4f2a&ei=12#comments`;

const msnHtml = `<!doctype html><html><head>
  <title>${HEADLINE} - MSN</title>
  <meta property="og:site_name" content="MSN">
  <meta property="og:title" content="${HEADLINE}">
  <link rel="canonical" href="https://www.publisher.example/sciences/vera-rubin">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: HEADLINE,
    author: { '@type': 'Person', name: 'Jean Dupont' },
    datePublished: '2026-10-03T08:15:00Z',
    image: ['https://img-s-msn-com.akamaized.net/vera-rubin.jpg'],
    articleBody: PARAGRAPHS.join('\n\n'),
  })}</script>
</head><body><nav>Accueil Actualité Sciences</nav><div id="root"></div></body></html>`;

// What a user copies from the MSN page: headline, byline, date, body —
// Windows line endings, NBSP, zero-width characters and decomposed accents.
const pastedMsn = [
  HEADLINE.normalize('NFD'),
  'Histoire de Jean Dupont',
  'Publié le 03/10/2026 à 10:15',
  ...PARAGRAPHS.map((p, i) => (i === 2 ? `​${p.replace(/ /, ' ')}` : p)),
].join('\r\n');

function scriptedDeps({ pages = [], analysis = 'Résumé scripté.\n\n## Points clés\n- un\n- deux', fail = false } = {}) {
  const calls = { analyze: [], generateTitle: 0, resolveStyle: [], listPages: 0 };
  return {
    calls,
    deps: {
      analysisPrompt: PROMPT,
      analyze: async ({ messages, input, wordCount }) => {
        calls.analyze.push({ messages, input, wordCount });
        return fail ? { ok: false, error: 'model offline', aiMs: 1, pairAttemptMs: 0 } : { ok: true, response: analysis, model: 'scripted-model', aiMs: 1, pairAttemptMs: 0 };
      },
      generateTitle: async () => { calls.generateTitle += 1; return 'Titre généré'; },
      resolveStyle: async (options) => { calls.resolveStyle.push(options); return { block: '', usedExamples: [] }; },
      personaNote: () => 'Ton calme. Français.',
      listPages: () => { calls.listPages += 1; return typeof pages === 'function' ? pages() : pages; },
    },
  };
}

function urlPathExtraction(html, url) {
  // Mirrors deep-capture.js extractArticle() success shape for a static page.
  const inspected = extractArticleCandidatesFromHtml(html, url);
  assert.ok(inspected.best?.quality.complete, 'fixture must pass the article quality gate');
  return {
    fallback: false, text: inspected.best.text, fullText: inspected.best.text, title: inspected.best.title,
    source_type: 'web', word_count: inspected.best.quality.words, truncated: false,
    imageUrls: inspected.best.imageUrls, page: inspected.page,
    extraction: { chosenExtractor: inspected.best.source, qualityStatus: 'COMPLETE' },
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('canonicalizeUrl: tracking, fragment, port, order, trailing slash; invalid → null', () => {
  assert.equal(canonicalizeUrl(SHARED_URL), ARTICLE_URL);
  assert.equal(canonicalizeUrl('HTTPS://Example.COM:443/a/b/?utm_source=x&b=2&a=1&fbclid=z#top'), 'https://example.com/a/b?a=1&b=2');
  assert.equal(canonicalizeUrl('https://example.com/?ei=keep'), 'https://example.com/?ei=keep', '`ei` is only tracking on MSN');
  assert.equal(canonicalizeUrl('https://user:pw@example.com/p'), 'https://example.com/p');
  assert.equal(canonicalizeUrl('ftp://example.com/x'), null);
  assert.equal(canonicalizeUrl('pas une url'), null);
  assert.equal(canonicalizeUrl(''), null);
});

test('normalizeArticleText: CRLF, NBSP, zero-width, NFC, one paragraph per line', () => {
  const input = 'Café  noir\r\n\r\n\r\n​Deuxième\tligne  ici\nTroisième﻿';
  assert.equal(normalizeArticleText(input), 'Café noir\n\nDeuxième ligne ici\n\nTroisième');
  assert.equal(normalizeArticleText('   ​­  '), '');
});

test('page metadata preserves s characters and normalizes all whitespace', () => {
  const html = `<!doctype html><html><head>
    <meta property="og:site_name" content="Business   Insider">
    <meta name="author" content="Les&#9;Echos">
    <meta property="article:published_time" content="2026-10-07&#10;  12:00:00Z">
  </head><body><article><p>Long enough article content for deterministic metadata extraction in this focused regression test.</p></article></body></html>`;
  const { page } = extractArticleCandidatesFromHtml(html, 'https://example.com/article');
  assert.equal(page.siteName, 'Business Insider');
  assert.equal(page.author, 'Les Echos');
  assert.equal(page.publishedAt, '2026-10-07 12:00:00Z');
});

test('normalizeArticleTitle only removes a suffix naming the site', () => {
  assert.equal(normalizeArticleTitle(`${HEADLINE} - MSN`, ['MSN']), HEADLINE);
  assert.equal(normalizeArticleTitle('Réforme | Le Journal', ['Le Journal']), 'Réforme');
  assert.equal(normalizeArticleTitle('Paris - Lyon : le TGV accélère', ['MSN']), 'Paris - Lyon : le TGV accélère');
});

test('resolveSourceName: site name > typed source > domain > web', () => {
  assert.deepEqual(resolveSourceName({ siteName: 'MSN', source: 'msn', url: ARTICLE_URL }), { name: 'MSN', strategy: 'site_name' });
  assert.deepEqual(resolveSourceName({ source: 'msn', url: ARTICLE_URL }), { name: 'Msn', strategy: 'domain' });
  assert.deepEqual(resolveSourceName({ source: 'Le Parisien', url: ARTICLE_URL }), { name: 'Le Parisien', strategy: 'user_source' });
  assert.deepEqual(resolveSourceName({ source: 'web', url: 'https://www.lemonde.fr/x' }), { name: 'Le Monde', strategy: 'domain' });
  assert.deepEqual(resolveSourceName({ source: 'web' }), { name: 'web', strategy: 'default' });
  assert.deepEqual(resolveSourceName({ source: 'www.msn.com', url: ARTICLE_URL }), { name: 'Msn', strategy: 'domain' }, 'raw hostname (download flow) → same parent');
});

test('toIsoDate: publication day from ISO, French and English dates; relative → null', () => {
  assert.equal(toIsoDate('2026-10-03T08:15:00Z'), '2026-10-03');
  assert.equal(toIsoDate('2026-10-03T23:30:00-02:00'), '2026-10-03', 'the day as written, not shifted to UTC');
  assert.equal(toIsoDate('Publié le 03/10/2026 à 10:15'), '2026-10-03');
  assert.equal(toIsoDate('Mis à jour le 1er octobre 2026'), '2026-10-01');
  assert.equal(toIsoDate('Published Oct 3, 2026'), '2026-10-03');
  assert.equal(toIsoDate('il y a 3 heures'), null);
  assert.equal(toIsoDate('31/02/2026'), null);
});

test('fingerprint ignores case, accents and punctuation but keeps every script', () => {
  assert.equal(textFingerprint('Élan — « Vite » !'), textFingerprint('elan vite'));
  assert.equal(textFingerprint('東京 🚀 São'), '東京 sao');
  assert.equal(contentHashOf(''), null);
});

// ── F1 core: same article through both paths ─────────────────────────────────

test('MSN article: URL extraction and pasted text converge on the same CanonicalArticle', () => {
  const extraction = urlPathExtraction(msnHtml, SHARED_URL);
  const viaUrl = buildCanonicalArticle(articleInputFromExtraction(SHARED_URL, extraction, { captureId: 'c-url' }));
  const viaPaste = buildCanonicalArticle({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL });

  assert.equal(viaUrl.title, HEADLINE);
  assert.equal(viaPaste.title, HEADLINE.normalize('NFC'));
  assert.equal(viaPaste.title, viaUrl.title);
  assert.equal(viaPaste.content, viaUrl.content, 'same body text');
  assert.equal(viaPaste.content, PARAGRAPHS.join('\n\n'));
  assert.equal(viaPaste.contentHash, viaUrl.contentHash);
  assert.equal(viaPaste.canonicalUrl, ARTICLE_URL);
  assert.equal(viaUrl.canonicalUrl, ARTICLE_URL);
  assert.equal(viaPaste.author, 'Jean Dupont');
  assert.equal(viaUrl.author, 'Jean Dupont');
  assert.equal(viaPaste.publishedAt, '2026-10-03');
  assert.equal(viaUrl.publishedAt, '2026-10-03');
  assert.equal(viaUrl.source.toLowerCase(), viaPaste.source.toLowerCase(), 'same parent (Docteur matches parents case-insensitively)');
  assert.equal(viaUrl.metadata.word_count, viaPaste.metadata.word_count);

  // Provenance is preserved and may differ.
  assert.equal(viaUrl.sourceUrl, SHARED_URL);
  assert.equal(viaUrl.metadata.provenance.path, 'url');
  assert.equal(viaUrl.metadata.provenance.extractor, 'json-ld');
  assert.equal(viaUrl.metadata.provenance.declaredCanonical, 'https://www.publisher.example/sciences/vera-rubin');
  assert.equal(viaPaste.metadata.provenance.path, 'paste');
  assert.deepEqual(viaPaste.metadata.provenance.headRemoved, ['title', 'byline', 'date']);
  assert.deepEqual(viaUrl.media.images, ['https://img-s-msn-com.akamaized.net/vera-rubin.jpg']);
  assert.deepEqual(viaPaste.media.images, []);
});

test('MSN article: both paths send the same prompt and build the same neuron', async () => {
  const extraction = urlPathExtraction(msnHtml, SHARED_URL);
  const url = scriptedDeps();
  const paste = scriptedDeps();
  const viaUrl = await runCanonicalArticleCapture(articleInputFromExtraction(SHARED_URL, extraction, { captureId: 'c-url' }), url.deps);
  const viaPaste = await runCanonicalArticleCapture({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL, captureId: 'c-paste' }, paste.deps);

  assert.equal(url.calls.analyze.length, 1);
  assert.equal(paste.calls.analyze.length, 1);
  assert.deepEqual(paste.calls.analyze[0].messages, url.calls.analyze[0].messages, 'identical analysis prompt');
  assert.match(url.calls.analyze[0].messages[0].content, /Ton calme\. Français\./, 'persona note on the URL path too');
  assert.equal(url.calls.generateTitle + paste.calls.generateTitle, 0, 'headline known on both paths — no model title');

  assert.equal(viaPaste.fallback, false);
  assert.equal(viaUrl.fallback, false);
  assert.equal(viaPaste.child.title, viaUrl.child.title);
  assert.equal(viaPaste.child.kind, 'link');
  assert.equal(viaPaste.child.kind, viaUrl.child.kind);
  assert.equal(viaPaste.child.content, viaUrl.child.content);
  assert.match(viaPaste.child.content, new RegExp(`Source : ${ARTICLE_URL.replace(/[.?]/g, '\\$&')}$`));
  assert.equal(viaPaste.parent.kind, 'channel');
  assert.equal(viaPaste.parent.title.toLowerCase(), viaUrl.parent.title.toLowerCase());

  const pm = viaPaste.child.metadata;
  const um = viaUrl.child.metadata;
  for (const key of ['canonicalUrl', 'contentHash', 'title', 'author', 'publishedAt']) {
    assert.equal(pm.canonical_article[key], um.canonical_article[key], `canonical_article.${key}`);
  }
  assert.equal(pm.url, SHARED_URL, 'original shared URL kept as provenance');
  assert.equal(pm.pasted_text, true);
  assert.equal(um.pasted_text, undefined);
  assert.equal(um.extraction.chosenExtractor, 'json-ld');
  for (const meta of [pm, um]) {
    assert.equal(meta.deep_capture, true);
    assert.equal(meta.captureStatus, 'EXTRACTED');
    assert.equal(meta.model_used, 'scripted-model');
    assert.equal(meta.truncated, false);
  }
});

test('article without author: author null on both paths, content unchanged', () => {
  const html = msnHtml.replace(/"author":\{[^}]*\},/, '');
  assert.ok(!html.includes('Jean Dupont'));
  const viaUrl = buildCanonicalArticle(articleInputFromExtraction(SHARED_URL, urlPathExtraction(html, SHARED_URL)));
  const viaPaste = buildCanonicalArticle({ path: 'paste', text: pastedMsn.replace('Histoire de Jean Dupont\r\n', ''), source: 'msn', url: SHARED_URL });
  assert.equal(viaUrl.author, null);
  assert.equal(viaPaste.author, null);
  assert.equal(viaPaste.contentHash, viaUrl.contentHash);
});

test('complex HTML (no JSON-LD, nav, scripts, cookie banner, table): body only, site suffix removed', () => {
  const body = Array.from({ length: 8 }, (_, i) => `<p>Section ${i + 1}. Le conseil municipal a voté un budget de ${i + 2} millions d’euros pour rénover les écoles, après une longue concertation avec les familles du quartier.</p>`).join('');
  const html = `<!doctype html><html><head><title>Budget des écoles | Le Journal</title><meta property="og:site_name" content="Le Journal">
    <meta name="author" content="Claire Martin"><meta property="article:published_time" content="2026-09-30T06:00:00+02:00"></head>
    <body><div class="cookie-banner">Tout accepter Gérer mes cookies</div><nav><a>Accueil</a><a>Politique</a></nav>
    <script>window.__STATE__ = { secret: "ne doit pas apparaître" };</script>
    <main><article><h1>Budget des écoles | Le Journal</h1>${body}<table><tr><td>2025</td><td>2026</td></tr></table></article></main>
    <aside>Lire aussi : autre article</aside><footer>© Le Journal</footer></body></html>`;
  const extraction = urlPathExtraction(html, 'https://www.lejournal.example/ville/budget-ecoles');
  const article = buildCanonicalArticle(articleInputFromExtraction('https://www.lejournal.example/ville/budget-ecoles', extraction));
  assert.equal(article.title, 'Budget des écoles');
  assert.equal(article.source, 'Le Journal');
  assert.equal(article.author, 'Claire Martin');
  assert.equal(article.publishedAt, '2026-09-30');
  assert.match(article.content, /^Section 1\./);
  assert.doesNotMatch(article.content, /secret|Tout accepter|Lire aussi|Accueil/);
});

test('Markdown and Unicode in pasted text are preserved verbatim (NFC)', () => {
  const text = [
    'Guide : migrer vers la nouvelle API',
    '## Contexte',
    '- **Étape 1** : lire [la doc](https://example.org/doc)',
    '- `npm install` puis tester 🚀',
    'مرحبا — 東京 — Ελλάδα — Café',
  ].join('\n');
  const article = buildCanonicalArticle({ path: 'paste', text, source: 'blog' });
  assert.equal(article.title, 'Guide : migrer vers la nouvelle API');
  assert.equal(article.content, '## Contexte\n\n- **Étape 1** : lire [la doc](https://example.org/doc)\n\n- `npm install` puis tester 🚀\n\nمرحبا — 東京 — Ελλάδα — Café');
  assert.equal(article.canonicalUrl, null);
  const { messages } = buildArticleAnalysis(article, { analysisPrompt: PROMPT });
  assert.ok(messages[1].content.endsWith(article.content), 'the model receives the Markdown as is');
});

test('incomplete content: a lone line is analysed as is and titled by the model', async () => {
  const { deps, calls } = scriptedDeps();
  const result = await runCanonicalArticleCapture({ path: 'paste', text: 'Une seule ligne sans corps', source: 'msn', captureId: 'c1' }, deps);
  assert.equal(result.fallback, false);
  assert.equal(calls.analyze[0].input, 'Une seule ligne sans corps', 'never emptied by head stripping');
  assert.equal(calls.generateTitle, 1);
  assert.equal(result.child.title, 'Titre généré');
  assert.equal(result.child.kind, 'note');
  assert.equal(result.child.metadata.canonical_article.provenance.titleStrategy, 'generated');
});

test('empty content after cleaning → explicit fallback, no model call', async () => {
  const { deps, calls } = scriptedDeps();
  const result = await runCanonicalArticleCapture({ path: 'paste', text: '​­﻿', source: 'msn', captureId: 'c2' }, deps);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'empty_content');
  assert.equal(result.child, undefined);
  assert.equal(calls.analyze.length, 0);
});

test('analysis failure → fallback with the error, no neuron', async () => {
  const { deps } = scriptedDeps({ fail: true });
  const result = await runCanonicalArticleCapture({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL, captureId: 'c3' }, deps);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, 'analysis_failed');
  assert.equal(result.error, 'model offline');
  assert.equal(result.child, undefined);
});

test('inaccessible source: blocked/invalid URL falls back before any network or model call', async () => {
  const blocked = await extractContent('http://127.0.0.1:9/article');
  assert.equal(blocked.fallback, true);
  assert.equal(blocked.reason, 'invalid_url');
  const invalid = await extractContent('notaurl');
  assert.equal(invalid.fallback, true);
});

test('long article: one shared truncation, full word count and hash kept', async () => {
  const long = Array.from({ length: 9000 }, (_, i) => `mot${i}`).join(' ');
  const { deps, calls } = scriptedDeps();
  const result = await runCanonicalArticleCapture({ path: 'paste', text: `Un titre assez long pour être un titre\n${long}`, source: 'blog', captureId: 'c4' }, deps);
  assert.equal(result.child.metadata.truncated, true);
  assert.equal(result.child.metadata.word_count, 9000);
  assert.match(calls.analyze[0].messages[1].content, /\[… contenu tronqué — 1000 mots omis …\]/);
  assert.match(calls.analyze[0].messages[1].content, /Contenu tronqué \(source trop longue\)/);
  assert.equal(result.child.metadata.canonical_article.contentHash, contentHashOf(long));
});

// ── Deduplication: identify, never delete ─────────────────────────────────────

test('findDuplicateArticle: canonical URL, legacy metadata.url, content hash; channels ignored', () => {
  const article = buildCanonicalArticle({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL });
  const pages = [
    { id: 'chan', kind: 'channel', title: 'MSN', metadata: { url: ARTICLE_URL } },
    { id: 'other', kind: 'link', title: 'Autre', metadata: { url: 'https://www.msn.com/fr-fr/autre/ar-AA2' } },
  ];
  assert.equal(findDuplicateArticle(pages, article), null);
  assert.deepEqual(
    findDuplicateArticle([...pages, { id: 'legacy', kind: 'link', title: 'Ancien', metadata: { url: `${ARTICLE_URL}?ocid=old` } }], article),
    { id: 'legacy', title: 'Ancien', matchedBy: 'canonical_url' },
  );
  assert.deepEqual(
    findDuplicateArticle([{ id: 'n1', kind: 'note', title: 'Collé', metadata: { canonical_article: { canonicalUrl: null, contentHash: article.contentHash } } }], { canonicalUrl: null, contentHash: article.contentHash }),
    { id: 'n1', title: 'Collé', matchedBy: 'content_hash' },
  );
  assert.equal(findDuplicateArticle(pages, { canonicalUrl: null, contentHash: null }), null);
});

test('dedup on SQLite: second capture of the same article (other path) is identified; existing neuron untouched', async () => {
  const first = await runCanonicalArticleCapture(
    articleInputFromExtraction(SHARED_URL, urlPathExtraction(msnHtml, SHARED_URL), { captureId: 'first', checkDuplicate: true }),
    scriptedDeps({ pages: () => getAllPagesMetaFromStore() }).deps,
  );
  assert.equal(first.fallback, false);
  assert.equal(first.duplicate, undefined);
  const saved = { id: 'article-1', kind: first.child.kind, title: first.child.title, blocks: [], links: [], metadata: first.child.metadata, createdAt: 1, updatedAt: 1 };
  savePageToStore(saved);
  const before = JSON.stringify(getPageFromStore('article-1'));
  const countBefore = getAllPagesMetaFromStore().length;

  // Pasted MSN text of the same article, shared link with other tracking.
  const second = scriptedDeps({ pages: () => getAllPagesMetaFromStore() });
  const dup = await runCanonicalArticleCapture({ path: 'paste', text: pastedMsn, source: 'msn', url: `${ARTICLE_URL}?ocid=sharelink`, captureId: 'second', checkDuplicate: true }, second.deps);
  assert.equal(dup.duplicate, true);
  assert.deepEqual(dup.existing, { id: 'article-1', title: HEADLINE, matchedBy: 'canonical_url' });
  assert.equal(second.calls.analyze.length, 0, 'identified before the model call');

  // Same pasted text without any link → content hash.
  const third = scriptedDeps({ pages: () => getAllPagesMetaFromStore() });
  const byHash = await runCanonicalArticleCapture({ path: 'paste', text: pastedMsn, source: 'msn', captureId: 'third', checkDuplicate: true }, third.deps);
  assert.equal(byHash.duplicate, true);
  assert.equal(byHash.existing.matchedBy, 'content_hash');

  // Explicit new version: no check, a new neuron is produced, nothing removed.
  const forced = await runCanonicalArticleCapture({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL, captureId: 'forced' }, scriptedDeps({ pages: () => getAllPagesMetaFromStore() }).deps);
  assert.equal(forced.duplicate, undefined);
  assert.equal(forced.fallback, false);
  assert.equal(getAllPagesMetaFromStore().length, countBefore);
  assert.equal(JSON.stringify(getPageFromStore('article-1')), before, 'existing neuron byte-identical');
});

test('route: checkDuplicate is opt-in and reaches both services', async () => {
  const seen = [];
  const services = {
    deepCapture: async (url, captureId, options) => { seen.push(['url', options]); return { fallback: false, duplicate: true, existing: { id: 'x', title: 'X', matchedBy: 'canonical_url' } }; },
    deepCaptureText: async (text, source, url, styleType, captureId, options) => { seen.push(['text', options]); return { fallback: true, reason: 'empty_content' }; },
  };
  const app = new Hono();
  app.route('/', createCaptureRoute({ services, logger: null }));
  const post = (body) => app.request('/capture/deep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const dup = await post({ url: SHARED_URL, checkDuplicate: true });
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).existing.id, 'x');
  await post({ url: SHARED_URL });
  await post({ text: pastedMsn, source: 'msn', url: SHARED_URL, checkDuplicate: true });
  await post({ text: pastedMsn, source: 'msn', checkDuplicate: 'yes' });
  assert.deepEqual(seen, [
    ['url', { checkDuplicate: true }],
    ['url', { checkDuplicate: false }],
    ['text', { checkDuplicate: true }],
    ['text', { checkDuplicate: false }],
  ]);
});
