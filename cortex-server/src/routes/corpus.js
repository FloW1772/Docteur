import { Hono } from 'hono';
import {
  insertCorpusSource, updateCorpusSource, getCorpusSources, getCorpusSourceById, deleteCorpusSource,
  savePageToStore, deletePageFromStore, getAllPagesFromStore, getPageFromStore, insertActivityLog,
} from '../lib/sqlite.js';
import { createJob, updateJobProgress, addJobError, finishJob, getJob } from '../lib/corpus-jobs.js';
import { extractContent } from '../lib/deep-capture.js';
import { assertSafeUrl } from '../lib/url-security.js';

const ALLOWED_EXT = new Set(['.md', '.markdown', '.txt']);
const DEFAULT_LIMIT = 500;
const HARD_MAX = 2000;
const SEARCH_CAPTURE_MAX = 20;
const MIN_WORDS = 200;

const REASON_LABELS = {
  invalid_url:        'URL invalide ou interdite (sécurité)',
  extraction_failed:  'extraction impossible (contenu non lisible)',
  article_expired:    'page expirée ou indisponible',
  video_content:       'page vidéo, pas un article',
  no_transcript:       'transcription vidéo indisponible',
};

function reasonLabel(reason) {
  return REASON_LABELS[reason] ?? reason ?? 'raison inconnue';
}

function countWords(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

// Articles longer than this are split into several linked neurons rather than
// truncated. nomic-embed-text's context window is ~2048 tokens (~8000 chars),
// and MAX_EMBED_CHARS (server.js) hard-truncates at 7500 chars — but token
// count varies with content density (markdown, accents, technical jargon), so
// we keep a wide safety margin well below that ceiling to avoid embedding
// failures on dense text (already observed on long-titled veilles).
const CHUNK_MAX_CHARS = 3_500;
const SUMMARY_MAX_INPUT_CHARS = 16_000;

function stripExt(name) {
  return name.replace(/\.[^./\\]+$/, '');
}

function extOf(name) {
  const m = /\.[^./\\]+$/.exec(name);
  return m ? m[0].toLowerCase() : '';
}

function titleFromContent(text, fallback) {
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 200);
  return fallback;
}

function textToBlocks(text) {
  return [{ id: crypto.randomUUID(), type: 'paragraph', content: text }];
}

// Splits long text into chunks on paragraph boundaries, never mid-sentence
// when avoidable. A single oversized paragraph is hard-split as a last resort.
function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

// Parses the incoming multipart form, applies keyword/size filters, returns
// the matched articles (not yet imported) plus stats about what was rejected.
async function scanFormData(formData) {
  const files = formData.getAll('files').filter(f => typeof f !== 'string');
  const keywordsRaw = String(formData.get('keywords') ?? '').trim();
  const keywords = keywordsRaw ? keywordsRaw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
  const minSize = formData.get('minSize') ? Number(formData.get('minSize')) : null;
  const maxSize = formData.get('maxSize') ? Number(formData.get('maxSize')) : null;
  const limit   = Math.min(Number(formData.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, HARD_MAX);

  if (files.length > HARD_MAX * 2) {
    return { error: `Refusé : ${files.length} fichiers détectés, dépasse largement la limite raisonnable (${HARD_MAX}). Filtrez le dossier source avant import.` };
  }

  const matched = [];
  let rejectedExt = 0;
  let rejectedSize = 0;

  for (const file of files) {
    if (!ALLOWED_EXT.has(extOf(file.name))) { rejectedExt++; continue; }
    const text = await file.text();
    const size = Buffer.byteLength(text, 'utf8');
    if (minSize !== null && size < minSize) { rejectedSize++; continue; }
    if (maxSize !== null && size > maxSize) { rejectedSize++; continue; }
    const title = titleFromContent(text, stripExt(file.name));
    if (keywords.length > 0) {
      const hay = `${title} ${file.name}`.toLowerCase();
      if (!keywords.some(k => hay.includes(k))) continue;
    }
    matched.push({ name: file.name, title, content: text, size });
  }

  const limited = matched.slice(0, limit);
  return {
    totalFound:  files.length,
    matched:     limited,
    matchedTotal: matched.length,
    truncated:   matched.length > limited.length,
    rejectedExt,
    rejectedSize,
    estimatedSizeBytes: limited.reduce((sum, a) => sum + a.size, 0),
    keywords, minSize, maxSize, limit,
  };
}

export function createCorpusRoute({ services, logger }) {
  const route = new Hono();

  // POST /api/corpus/scan — analyse sans importer, pour confirmation préalable
  route.post('/corpus/scan', async (c) => {
    let formData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Formulaire invalide' }, 400);
    }

    const result = await scanFormData(formData);
    if (result.error) return c.json({ error: result.error }, 413);

    return c.json({
      ok: true,
      totalFound:         result.totalFound,
      matchedCount:        result.matchedTotal,
      willImportCount:     result.matched.length,
      truncated:           result.truncated,
      rejectedExt:         result.rejectedExt,
      rejectedSize:        result.rejectedSize,
      estimatedSizeBytes:  result.estimatedSizeBytes,
      sampleTitles:        result.matched.slice(0, 15).map(a => a.title),
      limit:               result.limit,
    });
  });

  // POST /api/corpus/import — import réel, en tâche de fond (répond immédiatement)
  route.post('/corpus/import', async (c) => {
    let formData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Formulaire invalide' }, 400);
    }

    const corpusName = String(formData.get('corpusName') ?? '').trim();
    if (!corpusName) return c.json({ error: 'Le nom du corpus est requis' }, 400);

    const result = await scanFormData(formData);
    if (result.error) return c.json({ error: result.error }, 413);
    if (result.matched.length === 0) {
      return c.json({ error: 'Aucun article ne correspond aux filtres — rien à importer' }, 400);
    }

    const corpusId = crypto.randomUUID();
    const jobId    = crypto.randomUUID();

    // Split long articles into linked chunks up front so the job's progress
    // total reflects the real number of neurons that will be created.
    const articleChunks = result.matched.map(article => ({
      article,
      chunks: chunkText(article.content, CHUNK_MAX_CHARS),
    }));
    const totalNeurons = articleChunks.reduce((sum, a) => sum + a.chunks.length, 0);

    insertCorpusSource({
      id: corpusId, name: corpusName,
      keywords: result.keywords.join(','), min_size: result.minSize, max_size: result.maxSize,
    });
    createJob(jobId, totalNeurons);

    // Fire-and-forget background processing — the route responds before this finishes.
    (async () => {
      let imported = 0;
      let sizeBytes = 0;
      let errorCount = 0;
      let neuronCount = 0;
      const now = Date.now();

      for (let ai = 0; ai < articleChunks.length; ai++) {
        const { article, chunks } = articleChunks[ai];
        const articleKey = `${corpusId}-${ai}`;
        const chunkIds = chunks.map((_, ci) => `corpus-${corpusId}-${ai}-${ci}`);

        for (let ci = 0; ci < chunks.length; ci++) {
          const neuronId = chunkIds[ci];
          const title = chunks.length > 1 ? `${article.title} (partie ${ci + 1}/${chunks.length})` : article.title;
          const links = [chunkIds[ci - 1], chunkIds[ci + 1]].filter(Boolean);
          const metadata = {
            corpusId, corpusName, sourceTitle: article.name, articleTitle: article.title,
            articleKey, chunkIndex: ci, totalChunks: chunks.length, importedAt: now,
          };
          try {
            await services.indexNeuron({ id: neuronId, kind: 'corpus', title, content: chunks[ci], metadata });
            savePageToStore({
              id: neuronId, title, kind: 'corpus', blocks: textToBlocks(chunks[ci]), links,
              createdAt: now, updatedAt: now, metadata,
            });
            imported++;
            sizeBytes += Buffer.byteLength(chunks[ci], 'utf8');
          } catch (err) {
            errorCount++;
            addJobError(jobId, { name: article.name, error: err.message });
            logger?.warn({ corpusId, name: article.name, chunk: ci, error: err.message }, 'corpus article import failed');
          }
          neuronCount++;
          updateJobProgress(jobId, neuronCount);
          if (neuronCount % 5 === 0) await new Promise(r => setImmediate(r)); // yield to event loop
        }
      }

      updateCorpusSource(corpusId, {
        article_count: articleChunks.length,
        size_bytes: sizeBytes,
        status: 'done',
        error_count: errorCount,
      });
      finishJob(jobId, 'done');
      insertActivityLog({
        opType: 'corpus_import', item: corpusName,
        result: errorCount === 0 ? 'success' : 'failure',
        reason: errorCount > 0 ? `${errorCount} article(s) en échec sur ${articleChunks.length}` : null,
      });
    })().catch(err => {
      logger?.error({ corpusId, error: err.message }, 'corpus import background job crashed');
      finishJob(jobId, 'error');
      updateCorpusSource(corpusId, { status: 'error' });
      insertActivityLog({ opType: 'corpus_import', item: corpusName, result: 'failure', reason: err.message });
    });

    return c.json({ ok: true, corpusId, jobId, matched: totalNeurons }, 202);
  });

  // POST /api/corpus/search-capture — capture ciblée depuis une sélection de résultats de recherche
  // Réutilise l'extraction Readability/Playwright existante (extractContent) — jamais de résumé IA,
  // contenu intégral conservé et découpé comme pour l'import de fichiers (voir chunkText ci-dessus).
  route.post('/corpus/search-capture', async (c) => {
    const body = await c.req.json().catch(() => null);
    const subject = String(body?.subject ?? '').trim();
    const urls = Array.isArray(body?.urls)
      ? [...new Set(body.urls.filter(u => typeof u === 'string' && u.trim()))]
      : [];

    if (!subject) return c.json({ error: 'Le sujet est requis' }, 400);
    if (urls.length === 0) return c.json({ error: 'Aucune page sélectionnée' }, 400);
    if (urls.length > SEARCH_CAPTURE_MAX) {
      return c.json({ error: `Refusé : ${urls.length} pages sélectionnées, maximum ${SEARCH_CAPTURE_MAX} par opération.` }, 400);
    }

    const corpusId   = crypto.randomUUID();
    const corpusName = `Recherche : ${subject}`;
    const jobId      = crypto.randomUUID();

    insertCorpusSource({ id: corpusId, name: corpusName, keywords: subject, min_size: null, max_size: null });
    createJob(jobId, urls.length);

    // Fire-and-forget background processing — the route responds before this finishes.
    (async () => {
      let articlesOk = 0;
      let neuronsOk  = 0;
      let sizeBytes  = 0;
      let errorCount = 0;
      const now = Date.now();

      for (let ui = 0; ui < urls.length; ui++) {
        const url = urls[ui];
        try {
          assertSafeUrl(url);
          const extracted = await extractContent(url);
          if (extracted.fallback) {
            throw new Error(reasonLabel(extracted.reason));
          }
          const wordCount = countWords(extracted.text);
          if (wordCount < MIN_WORDS) {
            throw new Error(`contenu trop maigre (${wordCount} mots, minimum ${MIN_WORDS})`);
          }

          const articleTitle = extracted.title || url;
          const chunks    = chunkText(extracted.text, CHUNK_MAX_CHARS);
          const articleKey = `${corpusId}-${ui}`;
          const chunkIds   = chunks.map((_, ci) => `corpus-${corpusId}-${ui}-${ci}`);

          for (let ci = 0; ci < chunks.length; ci++) {
            const neuronId = chunkIds[ci];
            const title = chunks.length > 1 ? `${articleTitle} (partie ${ci + 1}/${chunks.length})` : articleTitle;
            const links = [chunkIds[ci - 1], chunkIds[ci + 1]].filter(Boolean);
            const metadata = {
              corpusId, corpusName, sourceTitle: url, articleTitle,
              articleKey, chunkIndex: ci, totalChunks: chunks.length, importedAt: now, searchSubject: subject,
            };
            await services.indexNeuron({ id: neuronId, kind: 'corpus', title, content: chunks[ci], metadata });
            savePageToStore({
              id: neuronId, title, kind: 'corpus', blocks: textToBlocks(chunks[ci]), links,
              createdAt: now, updatedAt: now, metadata,
            });
            neuronsOk++;
            sizeBytes += Buffer.byteLength(chunks[ci], 'utf8');
          }
          articlesOk++;
        } catch (err) {
          errorCount++;
          addJobError(jobId, { name: url, error: err.message });
          logger?.warn({ corpusId, url, error: err.message }, 'corpus search-capture page failed');
        }
        updateJobProgress(jobId, ui + 1);
        await new Promise(r => setImmediate(r)); // yield to event loop between pages
      }

      updateCorpusSource(corpusId, {
        article_count: articlesOk,
        size_bytes: sizeBytes,
        status: 'done',
        error_count: errorCount,
      });
      finishJob(jobId, 'done');
      logger?.info({ corpusId, articlesOk, neuronsOk, errorCount }, 'corpus search-capture done');
      insertActivityLog({
        opType: 'corpus_search_capture', item: corpusName,
        result: errorCount === 0 ? 'success' : 'failure',
        reason: errorCount > 0 ? `${errorCount} page(s) en échec sur ${urls.length}` : null,
      });
    })().catch(err => {
      logger?.error({ corpusId, error: err.message }, 'corpus search-capture job crashed');
      finishJob(jobId, 'error');
      updateCorpusSource(corpusId, { status: 'error' });
      insertActivityLog({ opType: 'corpus_search_capture', item: corpusName, result: 'failure', reason: err.message });
    });

    return c.json({ ok: true, corpusId, jobId, matched: urls.length }, 202);
  });

  // GET /api/corpus/jobs/:id — progression d'un import en cours
  route.get('/corpus/jobs/:id', (c) => {
    const job = getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'Job introuvable (terminé depuis longtemps ou serveur redémarré)' }, 404);
    return c.json(job);
  });

  // GET /api/corpus/list — corpus importés
  route.get('/corpus/list', (c) => {
    return c.json({ corpora: getCorpusSources() });
  });

  // POST /api/corpus/summarize/:id — résumé à la demande d'un article de référence
  // (jamais fait automatiquement à l'import — voir CONSIGNES : contenu intégral conservé)
  route.post('/corpus/summarize/:id', async (c) => {
    const id = c.req.param('id');
    const page = getPageFromStore(id);
    if (page?.kind !== 'corpus') return c.json({ error: 'Neurone de référence introuvable' }, 404);

    const articleKey = page.metadata?.articleKey;
    const title = page.metadata?.articleTitle ?? page.title;

    const siblings = articleKey
      ? getAllPagesFromStore()
          .filter(p => p.kind === 'corpus' && p.metadata?.articleKey === articleKey)
          .sort((a, b) => (a.metadata?.chunkIndex ?? 0) - (b.metadata?.chunkIndex ?? 0))
      : [page];

    const fullText = siblings.map(p => (p.blocks ?? []).map(b => b.content).join('\n\n')).join('\n\n');
    const truncated = fullText.length > SUMMARY_MAX_INPUT_CHARS;
    const inputText = truncated ? fullText.slice(0, SUMMARY_MAX_INPUT_CHARS) : fullText;

    try {
      await services.ensureOllamaAvailableOrThrow();
      const messages = [
        {
          role: 'system',
          content: 'Tu résumes un article de référence factuel (survie, premiers secours, procédures techniques…). '
            + 'Reste strictement fidèle au contenu fourni, conserve les données chiffrées, dosages et étapes importantes, '
            + "n'invente rien. Réponds en français, de façon concise et structurée.",
        },
        { role: 'user', content: `Titre : ${title}\n\n${inputText}` },
      ];
      const result = await services.runLocalStandard(messages);
      return c.json({ ok: true, summary: result.text, model_used: result.model, truncated });
    } catch (error) {
      const status = services.isOllamaError(error) ? 503 : 500;
      return c.json({ error: error.message }, status);
    }
  });

  // DELETE /api/corpus/:id — supprime un corpus entier (neurones + entrée), jamais les neurones personnels
  route.delete('/corpus/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    if (body?.confirm !== true) {
      return c.json({ error: 'Confirmation requise (confirm: true)' }, 400);
    }

    const corpus = getCorpusSourceById(id);
    if (!corpus) return c.json({ error: 'Corpus introuvable' }, 404);

    const pages = getAllPagesFromStore().filter(p => p.kind === 'corpus' && p.metadata?.corpusId === id);
    let deleted = 0;
    for (const page of pages) {
      try {
        await services.deleteNeuron(page.id);
        deletePageFromStore(page.id);
        deleted++;
      } catch (err) {
        logger?.warn({ id: page.id, error: err.message }, 'corpus neuron delete failed');
      }
    }
    deleteCorpusSource(id);

    return c.json({ ok: true, deleted });
  });

  return route;
}
