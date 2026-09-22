import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import {
  getKiwixSettings, setKiwixSettings, getKiwixSearchScope, setKiwixSearchScope,
  insertActivityLog,
} from '../lib/sqlite.js';
import {
  scanArchives, startKiwixServe, stopKiwixServe, getStatus, healthCheck,
  resolveKiwixServeBinary, defaultArchivesFolder, KIWIX_TOOLS_URL,
} from '../lib/kiwix.js';
import { listBooks, suggest, search, getContent, getRawAsset } from '../lib/kiwix-client.js';
import { searchCatalog } from '../lib/kiwix-catalog.js';
import { freeDiskSpaceBytes } from '../lib/disk-space.js';
import { sanitizeZimHtml } from '../lib/kiwix-sanitize.js';
import { assertSafeUrl } from '../lib/url-security.js';
import { assertCloudAllowed } from '../lib/strict-local.js';
import {
  KIWIX_ERROR_CODES, KiwixError, classifyKiwixError, kiwixErrorBody,
  assertSafeZimSegment, assertSafeSearchQuery, clampPageLength,
} from '../lib/kiwix-policy.js';

const STRICT_LOCAL_MESSAGE = 'Mode strictement local activé — le catalogue et le téléchargement Kiwix nécessitent une connexion internet et sont désactivés. Désactive le mode strict dans Paramètres pour les utiliser.';

const CHUNK_MAX_CHARS = 3_500;

// Kiwix catalog acquisition links point at a `.zim.meta4` metalink XML file
// (RFC 5854), not the `.zim` archive itself — fetching it directly would save
// the small XML manifest as if it were the archive. Metalink is a simple
// documented format: <url priority="N">...</url> entries, lowest priority
// first. Resolve to the best mirror before downloading; no XML lib needed,
// consistent with the regex-based OPDS parsing already used in kiwix-client.js.
async function resolveMetalinkUrl(metalinkUrl) {
  const res = await fetch(metalinkUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`metalink ${res.status}`);
  const xml = await res.text();
  const urls = [];
  const re = /<url\b[^>]*priority="(\d+)"[^>]*>([^<]+)<\/url>/g;
  let m;
  while ((m = re.exec(xml))) urls.push({ priority: Number(m[1]), href: m[2].trim() });
  if (urls.length === 0) throw new Error('metalink sans URL de miroir');
  urls.sort((a, b) => a.priority - b.priority);
  return urls[0].href;
}

function textToBlocks(text) {
  return [{ id: crypto.randomUUID(), type: 'paragraph', content: text }];
}

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
  return chunks;
}

export function createKiwixRoute({
  services, logger,
  // Injectable dependencies for testing — default to the real kiwix-serve
  // sidecar wiring. Tests supply deterministic mocks instead of spawning a
  // real kiwix-serve process, mirroring createSalesRoute({ search,
  // fetchContent, checkUrl }).
  kiwixSuggest = suggest,
  kiwixSearch = search,
  kiwixListBooks = listBooks,
  kiwixGetContent = getContent,
  kiwixGetRawAsset = getRawAsset,
  kiwixSearchCatalog = searchCatalog,
} = {}) {
  const route = new Hono();

  // ── Réglages ─────────────────────────────────────────────────────────────

  route.get('/kiwix/settings', (c) => {
    const settings = getKiwixSettings();
    return c.json({
      ...settings,
      archivesFolder: settings.archivesFolder || defaultArchivesFolder(),
      binaryFound: resolveKiwixServeBinary() !== null,
      kiwixToolsUrl: KIWIX_TOOLS_URL,
    });
  });

  route.put('/kiwix/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const updates = {};
    if (typeof body.kiwixServePath === 'string') updates.kiwixServePath = body.kiwixServePath.trim() || null;
    if (typeof body.archivesFolder === 'string') updates.archivesFolder = body.archivesFolder.trim() || null;
    if (body.port !== undefined) updates.port = Number(body.port) || 8090;
    if (typeof body.autoDetect === 'boolean') updates.autoDetect = body.autoDetect;
    setKiwixSettings(updates);
    return c.json({ ok: true, settings: getKiwixSettings() });
  });

  route.get('/kiwix/search-scope', (c) => c.json({ scope: getKiwixSearchScope() }));

  route.put('/kiwix/search-scope', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const scope = ['neurones', 'archives', 'les_deux'].includes(body.scope) ? body.scope : 'neurones';
    setKiwixSearchScope(scope);
    return c.json({ ok: true, scope });
  });

  // ── Archives locales ─────────────────────────────────────────────────────

  route.get('/kiwix/archives', (c) => {
    const settings = getKiwixSettings();
    const { folder, archives } = scanArchives(settings.archivesFolder);
    const totalBytes = archives.reduce((sum, a) => sum + a.sizeBytes, 0);
    return c.json({ folder, archives, totalBytes });
  });

  route.delete('/kiwix/archives/:fileName', async (c) => {
    const fileName = decodeURIComponent(c.req.param('fileName'));
    if (fileName.includes('..') || path.isAbsolute(fileName)) {
      return c.json({ error: 'Nom de fichier invalide' }, 400);
    }
    const settings = getKiwixSettings();
    const folder = settings.archivesFolder || defaultArchivesFolder();
    const fullPath = path.join(folder, fileName);
    if (!fullPath.toLowerCase().endsWith('.zim') || !fs.existsSync(fullPath)) {
      return c.json({ error: 'Archive introuvable' }, 404);
    }
    try {
      fs.unlinkSync(fullPath);
      insertActivityLog({ opType: 'kiwix_delete', item: fileName, result: 'success' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `Suppression impossible : ${err.message}` }, 500);
    }
  });

  // ── Cycle de vie du service ──────────────────────────────────────────────

  route.get('/kiwix/status', async (c) => {
    const settings = getKiwixSettings();
    const status = getStatus();
    if (status.running) return c.json(status);
    const up = await healthCheck(settings.port);
    return c.json({ ...status, running: up, externallyManaged: up });
  });

  route.post('/kiwix/start', async (c) => {
    const result = await startKiwixServe({ logger });
    if (result.ok) {
      insertActivityLog({ opType: 'kiwix_start', item: `${result.archives?.length ?? 0} archive(s)`, result: 'success' });
    } else {
      insertActivityLog({ opType: 'kiwix_start', item: result.error ?? 'erreur', result: 'failure', reason: result.message });
    }
    if (!result.ok) {
      // Map internal error tags to the normalized taxonomy without dropping
      // the French user-facing `message` the frontend already renders
      // (these are Docteur-authored strings, not raw kiwix-serve stderr, so
      // they stay — only spawn/process failures below get fully normalized).
      const codeMap = {
        binary_not_found: KIWIX_ERROR_CODES.NOT_CONFIGURED,
        no_archives: KIWIX_ERROR_CODES.LIBRARY_INVALID,
        port_in_use: KIWIX_ERROR_CODES.BACKEND_UNAVAILABLE,
        binding_not_loopback: KIWIX_ERROR_CODES.PROCESS_FAILED,
        spawn_failed: KIWIX_ERROR_CODES.PROCESS_FAILED,
      };
      const code = codeMap[result.error] ?? KIWIX_ERROR_CODES.PROCESS_FAILED;
      return c.json({ ...result, code }, 409);
    }
    return c.json(result, 200);
  });

  route.post('/kiwix/stop', (c) => {
    const result = stopKiwixServe();
    return c.json(result);
  });

  // ── Client kiwix-serve (proxy) ────────────────────────────────────────────

  route.get('/kiwix/suggest', async (c) => {
    const book = c.req.query('book') ?? '';
    const term = c.req.query('term') ?? '';
    if (!term.trim()) return c.json({ suggestions: [] });
    try {
      assertSafeSearchQuery(term);
      if (book) assertSafeZimSegment(book);
      const suggestions = await kiwixSuggest(book, term);
      return c.json({ suggestions });
    } catch (err) {
      if (err instanceof KiwixError) return c.json({ error: err.code }, 400);
      const classified = classifyKiwixError(err, { context: 'search' });
      logger?.warn?.({ error: err.message }, 'kiwix suggest failed');
      return c.json(kiwixErrorBody(classified), classified.status);
    }
  });

  route.get('/kiwix/search', async (c) => {
    const book = c.req.query('book') ?? '';
    const pattern = c.req.query('pattern') ?? '';
    if (!pattern.trim()) return c.json({ results: [] });
    try {
      assertSafeSearchQuery(pattern);
      if (book) assertSafeZimSegment(book);
      const pageLength = clampPageLength(c.req.query('pageLength'), 25);
      const results = await kiwixSearch(book, pattern, { pageLength });
      return c.json({ results });
    } catch (err) {
      if (err instanceof KiwixError) return c.json({ error: err.code }, 400);
      const classified = classifyKiwixError(err, { context: 'search' });
      logger?.warn?.({ error: err.message }, 'kiwix search failed');
      return c.json(kiwixErrorBody(classified), classified.status);
    }
  });

  route.get('/kiwix/books', async (c) => {
    try {
      const books = await kiwixListBooks();
      return c.json({ books });
    } catch (err) {
      const classified = classifyKiwixError(err, { context: 'books' });
      logger?.warn?.({ error: err.message }, 'kiwix books listing failed');
      return c.json(kiwixErrorBody(classified), classified.status);
    }
  });

  // GET /kiwix/content/:book/*  — article HTML nettoyé
  route.get('/kiwix/content/:book/*', async (c) => {
    const book = c.req.param('book');
    const fullPath = c.req.path.replace(/^.*\/kiwix\/content\/[^/]+\//, '');
    try {
      assertSafeZimSegment(book);
      assertSafeZimSegment(fullPath);
      const { html } = await kiwixGetContent(book, fullPath);
      const cleaned = sanitizeZimHtml(html, book);
      return c.json({ ...cleaned, book, path: fullPath });
    } catch (err) {
      if (err instanceof KiwixError) return c.json({ error: err.code }, 400);
      const classified = classifyKiwixError(err, { context: 'article' });
      logger?.warn?.({ error: err.message }, 'kiwix content fetch failed');
      return c.json(kiwixErrorBody(classified), classified.status);
    }
  });

  // GET /kiwix/raw/:book/* — asset binaire (images…), proxié
  route.get('/kiwix/raw/:book/*', async (c) => {
    const book = c.req.param('book');
    const fullPath = c.req.path.replace(/^.*\/kiwix\/raw\/[^/]+\//, '');
    try {
      assertSafeZimSegment(book);
      assertSafeZimSegment(fullPath);
      const { buffer, contentType } = await kiwixGetRawAsset(book, fullPath);
      return new Response(buffer, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' } });
    } catch (err) {
      if (err instanceof KiwixError) return c.json({ error: err.code }, 400);
      const classified = classifyKiwixError(err, { context: 'article' });
      logger?.warn?.({ error: err.message }, 'kiwix raw asset fetch failed');
      return c.json(kiwixErrorBody(classified), classified.status);
    }
  });

  // ── Catalogue distant (OPDS) ──────────────────────────────────────────────
  // Genuine outbound internet call (library.kiwix.org) — gated by Strict
  // Local Mode, unlike local search/article retrieval above which never
  // leaves the loopback sidecar.

  route.get('/kiwix/catalog', async (c) => {
    const blocked = assertCloudAllowed(c, STRICT_LOCAL_MESSAGE);
    if (blocked) return blocked;
    const q = c.req.query('q') ?? '';
    const lang = c.req.query('lang') ?? '';
    try {
      const entries = await kiwixSearchCatalog({ q, lang });
      return c.json({ entries });
    } catch (err) {
      return c.json({ error: err.message }, 502);
    }
  });

  // ── Espace disque ─────────────────────────────────────────────────────────

  route.get('/kiwix/disk-space', async (c) => {
    const settings = getKiwixSettings();
    const folder = settings.archivesFolder || defaultArchivesFolder();
    const freeBytes = await freeDiskSpaceBytes(folder);
    return c.json({ freeBytes });
  });

  // ── Téléchargement d'une archive du catalogue (SSE, annulable) ──────────────

  route.post('/kiwix/download', async (c) => {
    const blocked = assertCloudAllowed(c, STRICT_LOCAL_MESSAGE);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => ({}));
    let url = String(body?.url ?? '').trim();
    const fileName = String(body?.fileName ?? '').trim();
    const sizeBytes = Number(body?.sizeBytes ?? 0);

    if (!url || !/^https:\/\//i.test(url)) return c.json({ error: 'URL invalide' }, 400);
    try { assertSafeUrl(url); } catch (e) { return c.json({ error: e.message }, 400); } // SSRF guard
    if (!fileName || fileName.includes('..') || path.isAbsolute(fileName)) {
      return c.json({ error: 'Nom de fichier invalide' }, 400);
    }

    // Catalog acquisition links are `.zim.meta4` metalinks, not the archive
    // itself — resolve to the real mirror URL before streaming to disk.
    if (/\.meta4$/i.test(url)) {
      try {
        url = await resolveMetalinkUrl(url);
        assertSafeUrl(url); // re-validate the resolved mirror URL (SSRF guard)
      } catch (err) {
        return c.json({ error: `Impossible de résoudre le lien metalink : ${err.message}` }, 502);
      }
    }

    const settings = getKiwixSettings();
    const folder = settings.archivesFolder || defaultArchivesFolder();
    fs.mkdirSync(folder, { recursive: true });
    const destPath = path.join(folder, fileName.endsWith('.zim') ? fileName : `${fileName}.zim`);

    if (sizeBytes > 0) {
      const freeBytes = await freeDiskSpaceBytes(folder);
      if (freeBytes !== null && freeBytes < sizeBytes) {
        return c.json({
          error: `Espace insuffisant. Cette archive fait ${(sizeBytes / 1e9).toFixed(2)} Go. Espace libre : ${(freeBytes / 1e9).toFixed(2)} Go.`,
        }, 409);
      }
    }

    const enc = new TextEncoder();
    const reqSignal = c.req.raw.signal;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => {
          try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* client parti */ }
        };
        let fileHandle;
        try {
          send({ type: 'status', message: 'Connexion…' });
          const res = await fetch(url, { signal: reqSignal });
          if (!res.ok || !res.body) throw new Error(`Téléchargement échoué (${res.status})`);

          const total = Number(res.headers.get('content-length')) || sizeBytes || 0;
          let downloaded = 0;

          fileHandle = fs.createWriteStream(destPath);
          const reader = res.body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (reqSignal?.aborted) throw new DOMException('Annulé', 'AbortError');
            fileHandle.write(Buffer.from(value));
            downloaded += value.byteLength;
            send({ type: 'progress', downloaded, total, percent: total ? Math.round((downloaded / total) * 100) : null });
          }

          await new Promise((resolve, reject) => {
            fileHandle.end((err) => err ? reject(err) : resolve());
          });

          insertActivityLog({ opType: 'kiwix_download', item: fileName, result: 'success' });
          send({ type: 'done', filePath: destPath, fileName });
        } catch (err) {
          try { fileHandle?.destroy(); } catch { /* ignore */ }
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          const message = err.name === 'AbortError' ? 'Téléchargement annulé' : err.message;
          insertActivityLog({ opType: 'kiwix_download', item: fileName, result: 'failure', reason: message });
          send({ type: 'error', message });
        } finally {
          try { controller.close(); } catch { /* ignore */ }
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  });

  // ── Import d'un article dans le cortex ("Ajouter au cortex") ─────────────

  route.post('/kiwix/import', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const book = String(body?.book ?? '').trim();
    const articlePath = String(body?.path ?? '').trim();
    const title = String(body?.title ?? '').trim() || 'Article Kiwix';
    let text = String(body?.text ?? '').trim();

    if (!book || !articlePath) return c.json({ error: 'book et path requis' }, 400);

    if (!text) {
      try {
        const { html } = await kiwixGetContent(book, articlePath);
        const cleaned = sanitizeZimHtml(html, book);
        text = cleaned.text;
      } catch (err) {
        return c.json({ error: `Impossible de récupérer l'article : ${err.message}` }, 502);
      }
    }
    if (!text) return c.json({ error: 'Contenu introuvable pour cet article' }, 400);

    const chunks = chunkText(text, CHUNK_MAX_CHARS);
    const groupId = crypto.randomUUID();
    const now = Date.now();
    const chunkIds = chunks.map((_, i) => `kiwix-${groupId}-${i}`);
    const createdIds = [];

    for (let i = 0; i < chunks.length; i++) {
      const neuronId = chunkIds[i];
      const neuronTitle = chunks.length > 1 ? `${title} (partie ${i + 1}/${chunks.length})` : title;
      const links = [chunkIds[i - 1], chunkIds[i + 1]].filter(Boolean);
      const metadata = {
        source: 'kiwix', book, articlePath, articleTitle: title,
        chunkIndex: i, totalChunks: chunks.length, importedAt: now,
      };
      try {
        await services.indexNeuron({ id: neuronId, kind: 'reference', title: neuronTitle, content: chunks[i], metadata });
        createdIds.push(neuronId);
      } catch (err) {
        logger?.warn?.({ neuronId, error: err.message }, 'kiwix import chunk failed');
      }
    }

    insertActivityLog({
      opType: 'kiwix_import', item: title,
      result: createdIds.length > 0 ? 'success' : 'failure',
      reason: createdIds.length === 0 ? 'aucun chunk indexé' : null,
    });

    return c.json({ ok: createdIds.length > 0, neuronIds: createdIds, chunkCount: chunks.length });
  });

  return route;
}
