import { Hono } from 'hono';
import { createPreview } from '../lib/lancedb.js';

export function createSearchRoute({ services }) {
  const route = new Hono();

  route.post('/search', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.query) {
      return c.json({ error: 'Payload invalide. Champ requis: query.' }, 400);
    }

    c.set('requestPayload', body);
    c.set('modelUsed', services.embeddingModel);

    try {
      const query = String(body.query ?? '');
      const limit = Number(body.limit ?? 5);
      const threshold = Number(body.threshold ?? 0.2);
      const filterByKinds = Array.isArray(body.filter_by_kind) ? body.filter_by_kind : [];

      if (!query.trim()) {
        return c.json({ results: [], count: 0, latency_ms: 0 }, 200);
      }

      if (!services.getAllNeurons || !services.embedText || !services.searchVector) {
        throw new Error('Services de recherche incomplets.');
      }

      const queryLower = query.toLowerCase().trim();
      const allNeurons = await services.getAllNeurons();

      const fullTextMatches = new Map();
      for (const neuron of allNeurons) {
        if (filterByKinds.length > 0 && !filterByKinds.includes(neuron.kind)) {
          continue;
        }

        const titleLower = String(neuron.title ?? '').toLowerCase();
        const contentLower = String(neuron.content ?? '').toLowerCase();

        let fulltextScore = 0;
        if (titleLower.includes(queryLower)) {
          fulltextScore = 0.95;
        } else if (contentLower.includes(queryLower)) {
          fulltextScore = 0.85;
        }

        if (fulltextScore > 0) {
          fullTextMatches.set(String(neuron.id), {
            id: String(neuron.id),
            title: neuron.title ?? '',
            kind: neuron.kind ?? 'note',
            content: neuron.content ?? '',
            content_preview: createPreview(neuron.content ?? ''),
            score: fulltextScore,
          });
        }
      }

      const queryVector = await services.embedText(query);
      const vectorResults = await services.searchVector(queryVector, {
        limit: Math.max(limit * 10, 50),
        threshold: 0,
        filterByKinds,
      });

      const combined = new Map();

      for (const [id, data] of fullTextMatches.entries()) {
        combined.set(id, { ...data });
      }

      for (const vectorResult of vectorResults) {
        const vectorScore = Number.isFinite(vectorResult.score) ? vectorResult.score : 0;
        if (vectorScore <= 0) {
          continue;
        }

        const existing = combined.get(String(vectorResult.id));
        if (existing) {
          existing.score = Math.max(existing.score, vectorScore);
          continue;
        }

        combined.set(String(vectorResult.id), {
          id: String(vectorResult.id),
          title: vectorResult.title ?? '',
          kind: vectorResult.kind ?? 'note',
          content: vectorResult.content ?? '',
          content_preview: vectorResult.content_preview ?? createPreview(vectorResult.content ?? ''),
          score: vectorScore,
        });
      }

      const sortedResults = Array.from(combined.values())
        .filter((row) => row.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          title: row.title,
          kind: row.kind,
          content_preview: row.content_preview ?? createPreview(row.content ?? ''),
          score: Number(row.score.toFixed(4)),
        }));

      const result = {
        results: sortedResults,
        count: sortedResults.length,
        latency_ms: 0,
      };

      return c.json(result, 200);
    } catch (error) {
      const status = services.isOllamaError(error) ? 503 : 500;
      return c.json({ error: error.message }, status);
    }
  });

  return route;
}
