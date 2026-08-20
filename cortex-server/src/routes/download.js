import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkYtDlp, downloadVideo, downloadSubtitles, cleanSubtitleText } from '../lib/ytdlp.js';
import { assertSafeUrl } from '../lib/url-security.js';

const DEFAULT_FOLDER = 'D:\\upload';

export function createDownloadRoute({ services, logger }) {
  const route = new Hono();

  // GET /api/download/check — yt-dlp availability
  route.get('/download/check', async (c) => {
    const version = await checkYtDlp();
    return c.json({ available: version !== null, version: version ?? null });
  });

  // POST /api/download — SSE stream: progress → done/error
  // CORS is handled by the global middleware in server.js (localhost + LAN).
  route.post('/download', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url    = String(body?.url    ?? '').trim();
    const mode   = String(body?.mode   ?? 'download');   // link_only | download | download_analyze
    const folder = String(body?.folder ?? DEFAULT_FOLDER).trim();

    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'URL invalide' }, 400);
    }
    if (!['link_only', 'download', 'download_analyze'].includes(mode)) {
      return c.json({ error: 'mode invalide' }, 400);
    }
    // Sanitize folder: must be absolute, no traversal tricks
    if (!path.isAbsolute(folder) || folder.includes('..')) {
      return c.json({ error: 'Dossier invalide : chemin absolu requis' }, 400);
    }
    // SSRF guard — same as capture.js / deep-capture.js / whisper.js
    try { assertSafeUrl(url); } catch (e) {
      return c.json({ error: `URL bloquée : ${e.message}` }, 400);
    }

    const enc = new TextEncoder();
    const reqSignal = c.req.raw.signal;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => {
          try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* client disconnected */ }
        };

        try {
          if (mode === 'link_only') {
            // No yt-dlp: return immediately; neuron creation is frontend-only
            send({ type: 'done', title: '', filePath: null, analysis: null });
            return;
          }

          // ── Download ────────────────────────────────────────────────────────
          send({ type: 'status', message: 'Démarrage du téléchargement…' });

          const { filePath, title } = await downloadVideo(url, folder, {
            onProgress: (p) => send({ type: 'progress', ...p }),
            signal: reqSignal,
          });

          if (reqSignal?.aborted) { send({ type: 'error', message: 'Annulé' }); return; }

          send({ type: 'status', message: 'Téléchargement terminé.' });

          let analysis = null;

          if (mode === 'download_analyze') {
            // Try subtitles first
            const tempDir = path.join(os.tmpdir(), `docteur-subs-${Date.now()}`);
            send({ type: 'status', message: 'Recherche des sous-titres…' });
            const subsPath = await downloadSubtitles(url, tempDir, { signal: reqSignal });

            if (reqSignal?.aborted) { send({ type: 'error', message: 'Annulé' }); return; }

            if (subsPath) {
              send({ type: 'status', message: 'Analyse du contenu…' });
              try {
                const rawSrt = fs.readFileSync(subsPath, 'utf8');
                const text = cleanSubtitleText(rawSrt);
                // Clean up temp files
                try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }

                if (text.length > 50) {
                  const result = await services.deepCaptureText(text, new URL(url).hostname, url);
                  if (!result.fallback) {
                    analysis = result.child?.content ?? null;
                  }
                }
              } catch (err) {
                if (logger) logger.warn({ err: err.message }, 'subtitle analysis failed');
                // Non-fatal: proceed without analysis
              }
            } else {
              send({ type: 'status', message: 'Aucun sous-titre disponible — neurone créé sans analyse.' });
              try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
            }
          }

          const fileSize = filePath ? (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })() : 0;
          send({ type: 'done', title, filePath, fileSize, analysis });

        } catch (err) {
          if (logger) logger.error({ err: err.message, url }, 'DOWNLOAD_ERROR');
          if (err.name === 'AbortError') {
            send({ type: 'error', message: 'Téléchargement annulé' });
          } else {
            send({ type: 'error', message: err.message });
          }
        } finally {
          try { controller.close(); } catch { /* ignore */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  return route;
}
