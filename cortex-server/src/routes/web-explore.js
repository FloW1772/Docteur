import { Hono }             from 'hono';
import { stream }           from 'hono/streaming';
import { searchDuckDuckGo, dedupeByUrl } from '../lib/web-search.js';
import { extractContent }   from '../lib/deep-capture.js';
import { assertSafeUrl }    from '../lib/url-security.js';

const MAX_DEEP_PAGES     = 8;
const PAGE_TIMEOUT_MS    = 12_000;
const MAX_CONTENT_CHARS  = 6_000;
const MODE_A_LIMIT       = 25;

// In-memory cancel registry — lightweight, dies with server restart (acceptable)
const cancelledTokens = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchDdgWithFallback(query, limit) {
  const batch1 = await searchDuckDuckGo(query, Math.min(limit, 20));
  if (batch1.length >= limit) return batch1.slice(0, limit);
  // Try second page if we still need more
  const batch2 = await searchDuckDuckGo(query, limit - batch1.length, 30);
  return dedupeByUrl([...batch1, ...batch2]).slice(0, limit);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function createWebExploreRoute({ services, logger }) {
  const route = new Hono();

  // ── Mode A : raw results, NO AI ────────────────────────────────────────────
  route.post('/web-results', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.query) return c.json({ error: 'query requise' }, 400);

    const query = String(body.query).trim().slice(0, 500);

    try {
      const results = await fetchDdgWithFallback(query, MODE_A_LIMIT);
      return c.json({ results, count: results.length });
    } catch (err) {
      logger?.warn({ err: err.message }, 'web-results: DDG failed');
      return c.json({ error: err.message }, 503);
    }
  });

  // ── Cancel endpoint for Mode B ─────────────────────────────────────────────
  route.post('/web-deep/cancel', async (c) => {
    const body  = await c.req.json().catch(() => null);
    const token = String(body?.token ?? '');
    if (token) cancelledTokens.add(token);
    return c.json({ ok: true });
  });

  // ── Mode B : deep exploration, LOCAL AI only ────────────────────────────────
  // SSE events:
  //   { type: 'status', phase: 'searching'|'fetching'|'synthesizing', message, index?, total? }
  //   { type: 'page',   title, url, domain, index, total, ok }
  //   { type: 'result', content, sources: [{title,url,domain,ok}], model_used, latency_ms }
  //   { type: 'cancelled', content?, sources?, model_used?, latency_ms? }
  //   { type: 'error',  error }
  //   { type: 'done' }
  route.post('/web-deep', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.question) return c.json({ error: 'question requise' }, 400);

    const question   = String(body.question).trim().slice(0, 500);
    const maxPages   = Math.min(Number(body.max_pages ?? 6), MAX_DEEP_PAGES);
    const token      = String(body.cancel_token ?? '');

    return stream(c, async (s) => {
      const send = (data) => s.write(`data: ${JSON.stringify(data)}\n\n`);

      const isCancelled = () => token && cancelledTokens.has(token);

      try {
        // ── 1. Search ────────────────────────────────────────────────────────
        await send({ type: 'status', phase: 'searching', message: 'Recherche DuckDuckGo…' });

        let ddgResults;
        try {
          ddgResults = await fetchDdgWithFallback(question, maxPages);
        } catch (err) {
          logger?.warn({ err: err.message }, 'web-deep: DDG failed');
          await send({ type: 'error', error: `Moteur de recherche inaccessible : ${err.message}` });
          await send({ type: 'done' });
          return;
        }

        if (ddgResults.length === 0) {
          await send({ type: 'error', error: 'Aucun résultat DuckDuckGo.' });
          await send({ type: 'done' });
          return;
        }

        const total        = ddgResults.length;
        const pageContents = [];
        const pageStatuses = []; // { title, url, domain, ok }

        // ── 2. Fetch pages sequentially ──────────────────────────────────────
        for (let i = 0; i < ddgResults.length; i++) {
          if (isCancelled()) break;

          const { title, url, domain } = ddgResults[i];
          await send({
            type: 'status', phase: 'fetching',
            message: `Page ${i + 1}/${total} : lecture de ${domain}…`,
            index: i + 1, total,
          });

          let ok = false;
          try {
            assertSafeUrl(url);

            const extracted = await Promise.race([
              extractContent(url),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PAGE_TIMEOUT_MS)),
            ]);

            const text = (extracted?.text ?? '').trim();
            if (!extracted?.fallback && text.length > 80) {
              pageContents.push({
                title: String(extracted.title || title),
                url,
                domain,
                text: text.slice(0, MAX_CONTENT_CHARS),
              });
              ok = true;
            }
          } catch (err) {
            logger?.warn({ url, err: err.message }, 'web-deep: page fetch failed');
          }

          pageStatuses.push({ title, url, domain, ok });
          await send({ type: 'page', title, url, domain, index: i + 1, total, ok });
        }

        const wasCancelled = isCancelled();
        if (token) cancelledTokens.delete(token);

        // ── 3. Synthesize with local model ───────────────────────────────────
        if (pageContents.length === 0) {
          const msg = wasCancelled
            ? 'Annulé avant lecture de pages — aucun contenu disponible.'
            : 'Aucune page n\'a pu être lue (contenu dynamique ou accès restreint).';
          await send({
            type:    wasCancelled ? 'cancelled' : 'error',
            error:   msg,
            sources: pageStatuses,
          });
          await send({ type: 'done' });
          return;
        }

        await send({
          type: 'status', phase: 'synthesizing',
          message: `Synthèse de ${pageContents.length} page${pageContents.length > 1 ? 's' : ''}…`,
        });

        const contextBlock = pageContents
          .map((p, i) => `=== Source ${i + 1} : ${p.title} (${p.domain}) ===\n${p.text}`)
          .join('\n\n');

        const messages = [
          {
            role: 'system',
            content:
              'Tu es un assistant de recherche rigoureux. À partir des extraits web fournis, rédige une synthèse structurée en français sur le sujet donné. ' +
              'Pour chaque affirmation importante, cite la source entre parenthèses, ex : "(Source 1)". ' +
              'Structure avec des titres markdown ##. ' +
              'Termine par ## Limites (zones d\'incertitude, pages non lues). ' +
              'N\'invente aucun fait absent des extraits.',
          },
          {
            role: 'user',
            content: `Sujet : ${question}\n\n${contextBlock}`,
          },
        ];

        const started = Date.now();
        let synthesis, modelUsed;
        try {
          const result = await services.runLocalStandard(messages);
          synthesis  = result.text;
          modelUsed  = result.model;
        } catch (err) {
          await send({ type: 'error', error: `Modèle local indisponible : ${err.message}` });
          await send({ type: 'done' });
          return;
        }

        const sources = pageStatuses;
        await send({
          type:       wasCancelled ? 'cancelled' : 'result',
          content:    synthesis.trim(),
          sources,
          model_used: modelUsed,
          latency_ms: Date.now() - started,
        });

      } catch (err) {
        logger?.error({ err: err.message }, 'web-deep: unexpected error');
        if (token) cancelledTokens.delete(token);
        await send({ type: 'error', error: err.message });
      } finally {
        await send({ type: 'done' });
      }
    });
  });

  return route;
}
