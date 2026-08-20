import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { getPlaylistInfo } from '../lib/ytdlp.js';
import { downloadImageFromUrl, IMAGE_DIR } from '../lib/image.js';
import { getWhisperStats } from '../lib/sqlite.js';

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
        logger.error({ error_message: error.message, error_stack: error.stack, input }, 'CAPTURE_ERROR');
      }
      return c.json({ error: error.message }, 500);
    }
  });

  route.post('/capture/deep', async (c) => {
    const body   = await c.req.json().catch(() => null);
    const url    = String(body?.url  ?? '').trim();
    const text   = String(body?.text ?? '').trim();
    const source = String(body?.source ?? '').trim();

    // Mode texte collé : text + source requis
    if (text) {
      if (!source) {
        return c.json({ error: 'Payload invalide. Champ requis: source quand text est fourni.' }, 400);
      }
      c.set('requestPayload', { text: text.slice(0, 80), source, url });
      try {
        const started = Date.now();
        const result  = await services.deepCaptureText(text, source, url || undefined);
        c.set('modelUsed', result.model_used ?? 'deep-capture-text');
        if (logger) {
          logger.info({ source, url, word_count: result.child?.metadata?.word_count, latency_ms: Date.now() - started }, 'DEEP_CAPTURE_TEXT_DONE');
        }
        return c.json(result, 200);
      } catch (error) {
        if (logger) logger.error({ error_message: error.message, source }, 'DEEP_CAPTURE_TEXT_ERROR');
        return c.json({ error: error.message }, 500);
      }
    }

    // Mode URL : url requise
    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'Payload invalide. Champ requis: url (https?://) ou text+source.' }, 400);
    }

    const captureImagesFlag = body?.captureImages === true;

    c.set('requestPayload', { url });

    try {
      const started = Date.now();
      const result  = await services.deepCapture(url);
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
            if (logger) logger.warn({ url, imgUrl, error: err.message }, 'ARTICLE_IMAGE_SKIP');
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
        logger.info({ url, latency_ms: Date.now() - started, fallback: result.fallback }, 'DEEP_CAPTURE_DONE');
      }
      return c.json(result, 200);
    } catch (error) {
      if (logger) {
        logger.error({ error_message: error.message, url }, 'DEEP_CAPTURE_ERROR');
      }
      return c.json({ error: error.message }, 500);
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
          await send({ error: result.error ?? result.reason ?? 'Échec de la transcription' });
        } else {
          await send({ done: true, result });
        }
        if (logger) logger.info({ url, fallback: result.fallback }, 'WHISPER_CAPTURE_DONE');
      } catch (err) {
        if (err.name !== 'AbortError') {
          await send({ error: err.message });
          if (logger) logger.error({ error_message: err.message, url }, 'WHISPER_CAPTURE_ERROR');
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

    if (!transcription) {
      return c.json({ error: 'Transcription manquante' }, 400);
    }

    return stream(c, async (s) => {
      const send = (data) => s.write(`data: ${JSON.stringify(data)}\n\n`);
      try {
        const result = await services.resummariseTranscription({
          transcription, level, focus, usePowerful,
          onProgress: (p) => void send(p),
        });
        await send({ done: true, result });
      } catch (err) {
        if (err.name !== 'AbortError') {
          await send({ error: err.message });
        }
      }
    });
  });

  // POST /api/capture/playlist — returns playlist metadata (no download)
  route.post('/capture/playlist', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url  = String(body?.url ?? '').trim();

    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'URL invalide' }, 400);
    }

    try {
      const info = await getPlaylistInfo(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (logger) logger.info({ url, video_count: info.video_count, playlist: info.title }, 'PLAYLIST_INFO_DONE');
      return c.json(info, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message, url }, 'PLAYLIST_INFO_ERROR');
      const status = err.name === 'AbortError' ? 408 : 500;
      return c.json({ error: err.message }, status);
    }
  });

  return route;
}
