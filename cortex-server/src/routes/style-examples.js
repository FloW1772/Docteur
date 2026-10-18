// Exemples de style utilisateur — réglage global ON/OFF, sauvegarde d'un
// résumé produit comme exemple, et régénération d'un résumé avec un retour.
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getStyleExampleSettings, setStyleExampleSettings } from '../lib/sqlite.js';
import { publicErrorBody, safeErrorLogFields } from '../lib/safe-error-contract.js'; // [SEC-REMED-4B]

// [SEC-REMED-4B] Error text from a runtime / provider / subprocess / store is untrusted: the client gets a stable
// code + this fixed text (a PublicError keeps its own Docteur-written message).
const STYLE_FAILED = { code: 'STYLE_EXAMPLE_FAILED', message: 'L’opération sur l’exemple de style a échoué.' };

export function createStyleExamplesRoute({ services, logger }) {
  const route = new Hono();

  // ── GET/PUT /api/style-examples/settings ─────────────────────────────────
  route.get('/style-examples/settings', (c) => c.json(getStyleExampleSettings()));

  route.put('/style-examples/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body requis' }, 400);
    const enabled = body.enabled === true;
    return c.json(setStyleExampleSettings({ enabled }));
  });

  // ── POST /api/style-examples/save ────────────────────────────────────────
  // Crée un neurone 'exemple-resume' à partir d'un résumé produit.
  route.post('/style-examples/save', async (c) => {
    const body = await c.req.json().catch(() => null);
    const title = String(body?.title ?? '').trim();
    const content = String(body?.content ?? '').trim();
    const type = String(body?.type ?? '').trim();
    const sourceExcerpt = body?.source_excerpt ? String(body.source_excerpt).trim().slice(0, 500) : null;

    if (!content) return c.json({ error: 'content requis' }, 400);
    if (!type) return c.json({ error: 'type requis' }, 400);

    try {
      const id = crypto.randomUUID();
      const result = await services.indexNeuron({
        id,
        title: title || `Exemple — ${type}`,
        content,
        kind: 'exemple-resume',
        metadata: { type, ...(sourceExcerpt ? { source_excerpt: sourceExcerpt } : {}) },
      });
      return c.json({ id, ...result }, 200);
    } catch (err) {
      logger?.warn({ ...safeErrorLogFields(err, { operation: 'route.style_examples' }) }, 'style-examples: save failed');
      return c.json(publicErrorBody(err, STYLE_FAILED), 500);
    }
  });

  // ── GET /api/style-examples/types ────────────────────────────────────────
  // Liste des types déjà utilisés (suggestions d'autocomplétion).
  route.get('/style-examples/types', async (c) => {
    try {
      const all = await services.getAllNeurons();
      const types = new Set();
      for (const n of all) {
        if (n.kind === 'exemple-resume' && n.metadata?.type) types.add(String(n.metadata.type));
      }
      return c.json({ types: [...types].sort() });
    } catch (err) {
      return c.json({ types: [] });
    }
  });

  // ── POST /api/style-examples/regenerate-with-feedback ────────────────────
  // Régénère un résumé décevant en tenant compte d'un retour utilisateur.
  // Réutilise le pattern de /skills/:id/refine.
  route.post('/style-examples/regenerate-with-feedback', async (c) => {
    const body = await c.req.json().catch(() => null);
    const originalPrompt = String(body?.original_prompt ?? '').trim();
    const badOutput = String(body?.bad_output ?? '').trim();
    const feedback = String(body?.feedback ?? '').trim();

    if (!originalPrompt || !feedback) return c.json({ error: 'original_prompt et feedback requis' }, 400);

    const messages = [
      {
        role: 'system',
        content: 'Tu es un assistant d\'analyse de contenu. Produis une synthèse structurée en français avec du Markdown propre.',
      },
      {
        role: 'user',
        content:
          `${originalPrompt}` +
          (badOutput ? `\n\nRésultat décevant obtenu précédemment :\n${badOutput.slice(0, 3000)}` : '') +
          `\n\nTiens compte de ce retour utilisateur pour produire une meilleure version : ${feedback.slice(0, 500)}`,
      },
    ];

    try {
      const result = await services.runLocalStandard(messages);
      return c.json({ summary: result.text.trim(), model_used: result.model });
    } catch (err) {
      logger?.warn({ ...safeErrorLogFields(err, { operation: 'route.style_examples' }) }, 'style-examples: regenerate failed');
      return c.json(publicErrorBody(err, { code: 'LOCAL_MODEL_UNAVAILABLE', message: 'Modèle local indisponible.' }), 503);
    }
  });

  return route;
}
