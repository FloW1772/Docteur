import { Hono }               from 'hono';
import { stream }              from 'hono/streaming';
import { searchDuckDuckGo }    from '../lib/web-search.js';
import { extractContent }      from '../lib/deep-capture.js';
import { assertSafeUrl }       from '../lib/url-security.js';

const MAX_PAGES         = 3;
const PAGE_TIMEOUT_MS   = 10_000;
const MAX_CONTENT_CHARS = 6_000;

export function createWebAnswerRoute({ services, logger }) {
  const route = new Hono();

  // POST /api/web-answer  — SSE stream
  // Body: { question: string }
  // Events: status | result | error | done
  route.post('/web-answer', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.question) return c.json({ error: 'question requise' }, 400);

    const question = String(body.question).trim().slice(0, 500);

    return stream(c, async (s) => {
      const send = (data) => s.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        // ── 1. DuckDuckGo search ─────────────────────────────────────────────
        await send({ type: 'status', phase: 'searching', message: 'Recherche en cours…' });

        let ddgResults;
        try {
          ddgResults = await searchDuckDuckGo(question);
        } catch (err) {
          logger?.warn({ err: err.message }, 'web-answer: DDG search failed');
          await send({ type: 'error', error: `Moteur de recherche inaccessible : ${err.message}` });
          await send({ type: 'done' });
          return;
        }

        if (ddgResults.length === 0) {
          await send({ type: 'error', error: 'Aucun résultat DuckDuckGo. Reformule la question.' });
          await send({ type: 'done' });
          return;
        }

        // ── 2. Fetch up to MAX_PAGES pages ───────────────────────────────────
        const toFetch      = ddgResults.slice(0, MAX_PAGES);
        const pageContents = [];

        for (let i = 0; i < toFetch.length; i++) {
          const { title, url, domain } = toFetch[i];
          await send({ type: 'status', phase: 'fetching', message: `Lecture de ${domain}…`, index: i + 1, total: toFetch.length });

          try {
            assertSafeUrl(url); // SSRF guard

            const extracted = await Promise.race([
              extractContent(url),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PAGE_TIMEOUT_MS)),
            ]);

            const text = (extracted?.text ?? '').trim();
            if (!extracted?.fallback && text.length > 80) {
              pageContents.push({
                title:  String(extracted.title || title),
                url,
                domain,
                text:   text.slice(0, MAX_CONTENT_CHARS),
              });
            }
          } catch (err) {
            logger?.warn({ url, err: err.message }, 'web-answer: page fetch failed');
          }
        }

        // ── 3. Answer with local model ────────────────────────────────────────
        await send({ type: 'status', phase: 'answering', message: 'Synthèse en cours…' });

        const started = Date.now();

        if (pageContents.length === 0) {
          await send({
            type:       'result',
            answer:     'Les pages trouvées n\'ont pas pu être lues (contenu dynamique, JavaScript obligatoire, ou accès restreint). Consulte les sources directement via les liens ci-dessous.',
            sources:    toFetch.map(r => ({ title: r.title, url: r.url, domain: r.domain })),
            model_used: null,
            latency_ms: Date.now() - started,
          });
          await send({ type: 'done' });
          return;
        }

        const contextBlock = pageContents
          .map((p, i) => `=== Source ${i + 1} : ${p.title} (${p.domain}) ===\n${p.text}`)
          .join('\n\n');

        const messages = [
          {
            role:    'system',
            content: 'Tu es un assistant concis. Réponds en français à la question en te basant UNIQUEMENT sur les extraits web fournis. ' +
                     'Sois bref : quelques lignes, l\'essentiel. Pas de plan ni de titres. ' +
                     'Si les extraits ne permettent pas de répondre, dis-le honnêtement. N\'invente aucun fait.',
          },
          {
            role:    'user',
            content: `Question : ${question}\n\n${contextBlock}`,
          },
        ];

        let answer, modelUsed;
        try {
          const result = await services.runLocalStandard(messages);
          answer    = result.text;
          modelUsed = result.model;
        } catch (err) {
          await send({ type: 'error', error: `Modèle local indisponible : ${err.message}` });
          await send({ type: 'done' });
          return;
        }

        await send({
          type:       'result',
          answer:     answer.trim(),
          sources:    pageContents.map(p => ({ title: p.title, url: p.url, domain: p.domain })),
          model_used: modelUsed,
          latency_ms: Date.now() - started,
        });

      } catch (err) {
        logger?.error({ err: err.message }, 'web-answer: unexpected error');
        await send({ type: 'error', error: err.message });
      } finally {
        await send({ type: 'done' });
      }
    });
  });

  return route;
}
