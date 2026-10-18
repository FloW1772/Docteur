import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { getPlaylistInfo, normalizeDiscoveryOptions } from '../lib/ytdlp.js';
import { classifyDiscoveryInput, discoverYouTube } from '../lib/youtube-discovery.js';
import { getDefaultChannelQueue } from '../lib/youtube-channel-queue.js';
import { downloadImageFromUrl, IMAGE_DIR } from '../lib/image.js';
import { getWhisperStats } from '../lib/sqlite.js';
import { isPublicError, publicErrorBody, safeErrorLogFields } from '../lib/safe-error-contract.js'; // [SEC-REMED-4B]

// [SEC-REMED-4B] Capture pipelines call model runtimes / providers, fetch external pages and run subprocesses
// (yt-dlp, whisper): their error text is untrusted. Responses and logs carry a stable code + fixed text; a PublicError
// (Docteur-written) keeps its own message.
const CAPTURE_FAILED = { code: 'CAPTURE_FAILED', message: 'La capture a échoué.', status: 500 };
const WHISPER_RESULT_ERRORS = Object.freeze({
  whisper_failed: { code: 'WHISPER_FAILED', error: 'La transcription a échoué.' },
  analysis_failed: { code: 'ANALYSIS_FAILED', error: 'L’analyse de la transcription a échoué.' },
});

const MIN_IMAGE_BYTES = 50_000; // < 50 KB = thumbnail/vignette, skip

// Extract candidate image URLs from article metadata/blocks (Feature B)
function extractArticleImageUrls(neuron, sourceUrl) {
  const urls = [];
  // From metadata
  const meta = neuron.metadata ?? {};
  if (typeof meta.image === 'string' && /^https?:\/\//i.test(meta.image)) urls.push(meta.image);
  if (Array.isArray(meta.images)) {
    for (const u of meta.images) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.push(u);
    }
  }
  // From blocks (markdown image links)
  for (const block of neuron.blocks ?? []) {
    if (typeof block.content !== 'string') continue;
    const m = block.content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/g);
    if (m) {
      for (const tag of m) {
        const inner = tag.match(/\((https?:\/\/[^)]+)\)/)?.[1];
        if (inner) urls.push(inner);
      }
    }
  }
  // Deduplicate, exclude source domain to avoid tracking pixels
  let sourceDomain = '';
  try { sourceDomain = new URL(sourceUrl).hostname; } catch { /* ignore */ }
  return [...new Set(urls)].filter(u => {
    try { return new URL(u).hostname !== sourceDomain || u.match(/\.(jpe?g|png|webp|gif)(\?|$)/i); }
    catch { return false; }
  });
}

export function createCaptureRoute({ services, logger }) {
  const route = new Hono();

  route.post('/capture', async (c) => {
    const body  = await c.req.json().catch(() => null);
    const input = String(body?.input ?? '').trim();

    if (!input) {
      return c.json({ error: 'Payload invalide. Champ requis: input.' }, 400);
    }

    c.set('requestPayload', { input });
    c.set('modelUsed', 'capture-parser');

    try {
      const result = await services.captureInput(input);
      return c.json(result, 200);
    } catch (error) {
      if (logger) {
        logger.error({ ...safeErrorLogFields(error, { operation: 'capture.input' }), input }, 'CAPTURE_ERROR');
      }
      return c.json(publicErrorBody(error, CAPTURE_FAILED), 500);
    }
  });

  route.post('/capture/deep', async (c) => {
    const body   = await c.req.json().catch(() => null);
    const url    = String(body?.url  ?? '').trim();
    const text   = String(body?.text ?? '').trim();
    const source = String(body?.source ?? '').trim();
    // Article Canonical V1: opt-in "is this article already in Docteur?" check
    // (new captures only — re-analysing an existing neuron must not match itself).
    const captureOptions = { checkDuplicate: body?.checkDuplicate === true };

    // Mode texte collé : text + source requis
    if (text) {
      if (!source) {
        return c.json({ error: 'Payload invalide. Champ requis: source quand text est fourni.' }, 400);
      }
      c.set('requestPayload', { text: text.slice(0, 80), source, url });
      const captureId = randomUUID();
      if (logger) logger.info({ captureId, elapsedMs: 0, mode: 'text', source }, 'CAPTURE_START');
      try {
        const started = Date.now();
        const styleExampleType = body?.style_example_type ? String(body.style_example_type).trim() : undefined;
        const result  = await services.deepCaptureText(text, source, url || undefined, styleExampleType, captureId, captureOptions);
        c.set('modelUsed', result.model_used ?? 'deep-capture-text');
        if (logger) {
          logger.info({ captureId, source, url, word_count: result.child?.metadata?.word_count, latency_ms: Date.now() - started, timings: result.timings }, 'DEEP_CAPTURE_TEXT_DONE');
        }
        return c.json(result, 200);
      } catch (error) {
        if (logger) logger.error({ captureId, ...safeErrorLogFields(error, { operation: 'capture.deep_text' }), source }, 'DEEP_CAPTURE_TEXT_ERROR');
        return c.json(publicErrorBody(error, CAPTURE_FAILED), 500);
      }
    }

    // Mode URL : url requise
    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'Payload invalide. Champ requis: url (https?://) ou text+source.' }, 400);
    }

    const captureImagesFlag = body?.captureImages === true;
    const captureId = randomUUID();

    c.set('requestPayload', { url });
    if (logger) logger.info({ captureId, elapsedMs: 0, mode: 'url', url }, 'CAPTURE_START');

    try {
      const started = Date.now();
      const result  = await services.deepCapture(url, captureId, captureOptions);
      c.set('modelUsed', result.model_used ?? 'deep-capture');

      // Feature B: download article images if enabled and capture succeeded
      if (logger) logger.info({ url, captureImagesFlag, fallback: result.fallback }, 'CAPTURE_IMAGES_FLAG');
      if (captureImagesFlag && !result.fallback && result.child) {
        const metaImages = result.child.metadata?.images;
        if (logger) logger.info({ url, metadata_images: Array.isArray(metaImages) ? metaImages.length : 'none', metadata_keys: Object.keys(result.child.metadata ?? {}) }, 'CAPTURE_IMAGES_META');

        const imageUrls  = extractArticleImageUrls(result.child, url);
        if (logger) logger.info({ url, candidate_urls: imageUrls.length, urls: imageUrls.slice(0, 2) }, 'CAPTURE_IMAGES_CANDIDATES');

        const imageBlocks = [];
        for (const imgUrl of imageUrls.slice(0, 2)) {
          try {
            const id       = await downloadImageFromUrl(imgUrl, { signal: AbortSignal.timeout(15_000) });
            const imgPath  = path.join(IMAGE_DIR, id);
            const { size } = fs.statSync(imgPath);
            if (size < MIN_IMAGE_BYTES) {
              fs.rmSync(imgPath, { force: true });
              if (logger) logger.warn({ url, imgUrl, id, size }, 'ARTICLE_IMAGE_TOO_SMALL');
              continue;
            }
            imageBlocks.push({ id: `img_${Date.now()}_${imageBlocks.length}`, type: 'image', content: id });
            if (logger) logger.info({ url, imgUrl, id, size }, 'ARTICLE_IMAGE_OK');
          } catch (err) {
            if (logger) logger.warn({ url, imgUrl, ...safeErrorLogFields(err, { operation: 'capture.article_image' }) }, 'ARTICLE_IMAGE_SKIP');
          }
        }
        if (imageBlocks.length > 0) {
          result.child.blocks = [...imageBlocks, ...(result.child.blocks ?? [])];
          if (logger) logger.info({ url, count: imageBlocks.length }, 'ARTICLE_IMAGES_CAPTURED');
        } else {
          if (logger) logger.warn({ url, candidate_count: imageUrls.length }, 'ARTICLE_IMAGES_NONE');
        }
      }

      if (logger) {
        logger.info({ captureId, url, latency_ms: Date.now() - started, fallback: result.fallback, reason: result.reason ?? null, extraction: result.extraction ?? null, timings: result.timings }, 'DEEP_CAPTURE_DONE');
      }
      return c.json(result, 200);
    } catch (error) {
      if (logger) {
        logger.error({ captureId, ...safeErrorLogFields(error, { operation: 'capture.deep_url' }), url }, 'DEEP_CAPTURE_ERROR');
      }
      return c.json(publicErrorBody(error, CAPTURE_FAILED), 500);
    }
  });

  // POST /api/capture/whisper — SSE streaming: download audio → transcribe → analyse
  route.post('/capture/whisper', async (c) => {
    const body = await c.req.json().catch(() => null);
    const url      = String(body?.url ?? '').trim();
    const rawProvider = body?.provider;
    const provider = rawProvider === 'groq' ? 'groq' : rawProvider === 'auto' ? 'auto' : 'local';

    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'URL invalide' }, 400);
    }

    const controller = new AbortController();
    // If client disconnects, abort
    c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    return stream(c, async (s) => {
      const send = (data) => s.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        const result = await services.deepCaptureWhisper(url, (progress) => {
          void send(progress);
        }, controller.signal, provider);

        if (result.fallback) {
          // The service's own text is never relayed: the closed reason picks the message.
          await send(WHISPER_RESULT_ERRORS[result.reason] ?? WHISPER_RESULT_ERRORS.whisper_failed);
        } else {
          await send({ done: true, result });
        }
        if (logger) logger.info({ url, fallback: result.fallback }, 'WHISPER_CAPTURE_DONE');
      } catch (err) {
        if (err.name !== 'AbortError') {
          await send(isPublicError(err) ? { error: err.message, code: err.code } : WHISPER_RESULT_ERRORS.whisper_failed);
          if (logger) logger.error({ ...safeErrorLogFields(err, { errorCode: 'WHISPER_FAILED', operation: 'capture.whisper' }), url }, 'WHISPER_CAPTURE_ERROR');
        }
      }
    });
  });

  // GET /api/capture/whisper/stats — Whisper usage statistics
  route.get('/capture/whisper/stats', (c) => {
    return c.json(getWhisperStats());
  });

  // POST /api/capture/resummarise — SSE: regenerate summary from stored transcription
  route.post('/capture/resummarise', async (c) => {
    const body          = await c.req.json().catch(() => null);
    const transcription = String(body?.transcription ?? '').trim();
    const level         = String(body?.level ?? 'standard');
    const focus         = String(body?.focus ?? '').trim();
    const usePowerful   = body?.use_powerful === true;
    const styleExampleType = body?.style_example_type ? String(body.style_example_type).trim() : undefined;

    if (!transcription) {
      return c.json({ error: 'Transcription manquante' }, 400);
    }

    return stream(c, async (s) => {
      const send = (data) => s.write(`data: ${JSON.stringify(data)}\n\n`);
      try {
        const result = await services.resummariseTranscription({
          transcription, level, focus, usePowerful, styleExampleType,
          onProgress: (p) => void send(p),
        });
        await send({ done: true, result });
      } catch (err) {
        if (err.name !== 'AbortError') {
          await send(publicErrorBody(err, { code: 'RESUMMARISE_FAILED', message: 'La régénération du résumé a échoué.' }));
          if (logger) logger.error(safeErrorLogFields(err, { errorCode: 'RESUMMARISE_FAILED', operation: 'capture.resummarise' }), 'RESUMMARISE_ERROR');
        }
      }
    });
  });

  // POST /api/capture/discover — YouTube Smart Discovery V2. The URL decides the mode (no limit parameter, no cap).
  //   body: { input: string, context?: 'youtube' }   ('youtube' = explicit YouTube workflow: a bare @handle is accepted)
  //   NDJSON events: start, mode, phase_start, progress, items_batch, phase_done, done | cancelled | error
  route.post('/capture/discover', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = typeof body?.input === 'string' ? body.input.trim() : '';
    const allowBareHandle = body?.context === 'youtube';
    const classified = classifyDiscoveryInput(input, { allowBareHandle });
    if (!classified.ok) return c.json({ error: 'URL YouTube non supportée', reason: classified.reason }, 400);

    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return stream(c, async (s) => {
      const ctrl = new AbortController();
      const onClientGone = () => ctrl.abort();
      if (c.req.raw.signal.aborted) ctrl.abort();
      c.req.raw.signal.addEventListener('abort', onClientGone, { once: true });
      s.onAbort(onClientGone);
      let writes = Promise.resolve();
      const send = data => {
        if (ctrl.signal.aborted && data.type !== 'cancelled') return writes;
        writes = writes.then(() => s.write(`${JSON.stringify(data)}\n`)).catch(() => {});
        return writes;
      };
      try {
        const result = await discoverYouTube(input, { signal: ctrl.signal, allowBareHandle, onEvent: event => { void send(event); } });
        if (logger) logger.info({ mode: classified.mode, status: result.status, total: result.total, duration_ms: result.durationMs }, 'YOUTUBE_DISCOVERY_END');
      } catch (err) {
        if (logger) logger.error(safeErrorLogFields(err, { errorCode: 'YOUTUBE_DISCOVERY_FAILED', operation: 'capture.discover' }), 'YOUTUBE_DISCOVERY_FAILED');
        await send({ type: 'error', name: err.name, code: 'INTERNAL', message: 'Échec de la découverte YouTube' });
      } finally {
        c.req.raw.signal.removeEventListener('abort', onClientGone);
      }
      await writes;
    });
  });

  // YouTube Multi-Channel V1 — several channel URLs (one per line) discovered through one bounded FIFO queue. Every job runs
  // the same discoverYouTube as /capture/discover above; the queue survives the client closing the view (poll to follow it).
  //   POST /capture/discover/channels                          { text: string } | { inputs: string[] }  → batch snapshot
  //   GET  /capture/discover/channels/:batchId                  → batch snapshot (per-channel status + global summary)
  //   GET  /capture/discover/channels/:batchId/jobs/:jobId/items → grouped result of ONE completed channel
  //   POST /capture/discover/channels/:batchId/cancel            → cancel every unfinished channel
  //   POST /capture/discover/channels/:batchId/jobs/:jobId/cancel | /retry
  const channelQueue = () => services?.youtubeChannelQueue ?? getDefaultChannelQueue({ logger });
  const queueReply = (c, result) => (result?.error ? c.json({ error: result.error.code, ...(result.snapshot ? { batch: result.snapshot } : {}) }, result.error.status) : c.json(result));

  route.post('/capture/discover/channels', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = Array.isArray(body?.inputs) ? body.inputs : typeof body?.text === 'string' ? body.text : '';
    try {
      return c.json(channelQueue().createBatch(input));
    } catch (err) {
      if (['EMPTY_INPUT', 'TOO_MANY_INPUTS'].includes(err.code)) return c.json({ error: err.code, message: err.message }, 400);
      if (err.code === 'QUEUE_CLOSED') return c.json({ error: err.code, message: err.message }, 503);
      throw err;
    }
  });
  route.get('/capture/discover/channels/:batchId', c => queueReply(c, channelQueue().getBatch(c.req.param('batchId'))));
  route.get('/capture/discover/channels/:batchId/jobs/:jobId/items', c => queueReply(c, channelQueue().getJobResult(c.req.param('batchId'), c.req.param('jobId'))));
  route.post('/capture/discover/channels/:batchId/cancel', c => queueReply(c, channelQueue().cancelBatch(c.req.param('batchId'))));
  route.post('/capture/discover/channels/:batchId/jobs/:jobId/cancel', c => queueReply(c, channelQueue().cancelJob(c.req.param('batchId'), c.req.param('jobId'))));
  route.post('/capture/discover/channels/:batchId/jobs/:jobId/retry', c => queueReply(c, channelQueue().retryJob(c.req.param('batchId'), c.req.param('jobId'))));

  // POST /api/capture/playlist — returns playlist metadata (no download)
  route.post('/capture/playlist', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url  = String(body?.url ?? '').trim();

    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'URL invalide' }, 400);
    }

    let discovery;
    try {
      const requestedMode = body?.mode ?? (body?.limit === null ? 'all' : 'limited');
      const requestedLimit = requestedMode === 'all'
        ? body?.limit
        : (body?.limit === undefined ? 100 : body.limit);
      discovery = normalizeDiscoveryOptions({ mode: requestedMode, limit: requestedLimit });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }

    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return stream(c, async (s) => {
      let writes = Promise.resolve();
      const send = data => {
        writes = writes.then(() => s.write(`${JSON.stringify(data)}\n`));
        return writes;
      };
      await send({ type: 'started', mode: discovery.mode, limit: discovery.limit });
      try {
        const info = await getPlaylistInfo(url, {
          signal: c.req.raw.signal,
          mode: discovery.mode,
          limit: discovery.limit ?? undefined,
          onProgress: ({ count }) => { void send({ type: 'progress', count }); },
        });
        if (logger) logger.info({ url, video_count: info.video_count, playlist: info.title }, 'PLAYLIST_INFO_DONE');
        await send({ type: 'done', result: info });
      } catch (err) {
        // yt-dlp stderr is untrusted: fixed text; only AbortError is kept distinct (client cancel).
        if (logger) logger.error({ ...safeErrorLogFields(err, { errorCode: 'PLAYLIST_INFO_FAILED', operation: 'capture.playlist' }), url }, 'PLAYLIST_INFO_ERROR');
        await send({ type: 'error', name: err?.name === 'AbortError' ? 'AbortError' : 'Error', code: 'PLAYLIST_INFO_FAILED', message: 'Lecture de la playlist impossible.' });
      }
      await writes;
    });
  });

  return route;
}
