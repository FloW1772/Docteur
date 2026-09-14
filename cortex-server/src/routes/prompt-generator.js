import { Hono } from 'hono';
import {
  getAllGeneratedPrompts, getGeneratedPromptById, countGeneratedPrompts,
  insertGeneratedPrompt, updateGeneratedPrompt, deleteGeneratedPrompt,
  searchGeneratedPrompts, getPromptGeneratorSettings, setPromptGeneratorSettings,
  getRouterSettings,
  getPromptDestinations, setPromptDestinations,
  recordPromptSendEvent, getPromptSendEventsForGeneration,
} from '../lib/sqlite.js';
import { listAvailableModels, buildDraftMessages, buildReviewMessages, parseReviewOutput } from '../lib/prompt-generator.js';
import { runAiTask } from '../lib/router.js';

const MAX_REQUEST_CHARS = 2_000;
const MAX_PROMPTS       = 500;

function resolveProvider(modelId, requestedProvider) {
  if (requestedProvider) return requestedProvider;
  return 'local';
}

function isValidDestinationUrl(url) {
  if (url === '' || url === null || url === undefined) return true;
  return /^https?:\/\//i.test(url);
}

export function createPromptGeneratorRoute({ services, ollamaClient, logger }) {
  const route = new Hono();

  // ── GET /prompt-generator/models — available draft/review models ───────────
  route.get('/prompt-generator/models', async (c) => {
    try {
      const installedNames = (await services.ollamaHealth()).models.map(m => m.name);
      const models = await listAvailableModels(installedNames);
      return c.json(models);
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // ── GET /prompt-generator/settings ──────────────────────────────────────────
  route.get('/prompt-generator/settings', (c) => c.json(getPromptGeneratorSettings()));

  // ── POST /prompt-generator/settings ─────────────────────────────────────────
  route.post('/prompt-generator/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body requis' }, 400);
    setPromptGeneratorSettings({
      default_draft_model:     body.default_draft_model ?? null,
      default_draft_provider:  body.default_draft_provider ?? null,
      default_review_model:    body.default_review_model ?? null,
      default_review_provider: body.default_review_provider ?? null,
    });
    return c.json(getPromptGeneratorSettings());
  });

  // ── GET /prompt-generator/destinations — list (seeded on first read) ────────
  route.get('/prompt-generator/destinations', (c) => c.json({ destinations: getPromptDestinations() }));

  // ── POST /prompt-generator/destinations — add one ───────────────────────────
  route.post('/prompt-generator/destinations', async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = String(body?.name ?? '').trim();
    if (!name) return c.json({ error: 'name requis' }, 400);
    const url = String(body?.url ?? '').trim();
    if (!isValidDestinationUrl(url)) return c.json({ error: 'url doit être http/https ou vide' }, 400);

    const list = getPromptDestinations();
    const destination = {
      id: crypto.randomUUID(),
      name,
      url,
      category: String(body?.category ?? '').trim() || 'AUTRES',
      urlTemplate: String(body?.urlTemplate ?? '').trim(),
      favorite: !!body?.favorite,
      order: list.length,
    };
    const next = [...list, destination];
    setPromptDestinations(next);
    return c.json({ destinations: next, destination }, 201);
  });

  // ── PUT /prompt-generator/destinations/reorder — declared before /:id ───────
  route.put('/prompt-generator/destinations/reorder', async (c) => {
    const body = await c.req.json().catch(() => null);
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    if (!ids) return c.json({ error: 'ids (tableau) requis' }, 400);

    const list = getPromptDestinations();
    const byId = new Map(list.map(d => [d.id, d]));
    const reordered = ids.map(id => byId.get(id)).filter(Boolean);
    for (const d of list) if (!ids.includes(d.id)) reordered.push(d);
    const next = reordered.map((d, i) => ({ ...d, order: i }));
    setPromptDestinations(next);
    return c.json({ destinations: next });
  });

  // ── PUT /prompt-generator/destinations/:id — edit one ───────────────────────
  route.put('/prompt-generator/destinations/:id', async (c) => {
    const id = c.req.param('id');
    const list = getPromptDestinations();
    const existing = list.find(d => d.id === id);
    if (!existing) return c.json({ error: 'Destination introuvable' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body requis' }, 400);

    const updated = { ...existing };
    if (body.name        !== undefined) updated.name = String(body.name).trim();
    if (body.url         !== undefined) {
      const url = String(body.url).trim();
      if (!isValidDestinationUrl(url)) return c.json({ error: 'url doit être http/https ou vide' }, 400);
      updated.url = url;
    }
    if (body.category    !== undefined) updated.category = String(body.category).trim() || 'AUTRES';
    if (body.urlTemplate !== undefined) updated.urlTemplate = String(body.urlTemplate).trim();
    if (body.favorite    !== undefined) updated.favorite = !!body.favorite;

    const next = list.map(d => d.id === id ? updated : d);
    setPromptDestinations(next);
    return c.json({ destinations: next, destination: updated });
  });

  // ── DELETE /prompt-generator/destinations/:id ───────────────────────────────
  route.delete('/prompt-generator/destinations/:id', (c) => {
    const id = c.req.param('id');
    const list = getPromptDestinations();
    if (!list.some(d => d.id === id)) return c.json({ error: 'Destination introuvable' }, 404);
    const next = list.filter(d => d.id !== id);
    setPromptDestinations(next);
    return c.json({ destinations: next, ok: true });
  });

  // ── GET /prompt-generator — list with filters ───────────────────────────────
  route.get('/prompt-generator', (c) => {
    const from        = c.req.query('from') || undefined;
    const to           = c.req.query('to') || undefined;
    const model        = c.req.query('model') || undefined;
    const outcome      = c.req.query('outcome') || undefined;
    const q            = c.req.query('q') || undefined;
    const templatesOnly = c.req.query('templates') === '1';

    const prompts = q
      ? searchGeneratedPrompts(q)
      : getAllGeneratedPrompts({ from, to, model, outcome, is_template: templatesOnly ? true : undefined });

    return c.json({ prompts, count: countGeneratedPrompts() });
  });

  // ── GET /prompt-generator/:id ────────────────────────────────────────────────
  route.get('/prompt-generator/:id', (c) => {
    const prompt = getGeneratedPromptById(c.req.param('id'));
    if (!prompt) return c.json({ error: 'Prompt introuvable' }, 404);
    return c.json({ prompt });
  });

  // ── POST /prompt-generator/generate — two-stage draft + review ─────────────
  route.post('/prompt-generator/generate', async (c) => {
    const body = await c.req.json().catch(() => null);
    const request = String(body?.request ?? '').trim();
    if (!request) return c.json({ error: 'request requis' }, 400);
    if (countGeneratedPrompts() >= MAX_PROMPTS) {
      return c.json({ error: `Limite de ${MAX_PROMPTS} prompts atteinte — supprimez-en avant d'en générer d'autres` }, 409);
    }

    const draftModelId    = String(body?.draft_model ?? '').trim();
    const reviewModelId   = String(body?.review_model ?? '').trim();
    const draftProvider   = resolveProvider(draftModelId, body?.draft_provider);
    const reviewProvider  = resolveProvider(reviewModelId, body?.review_provider);
    if (!draftModelId || !reviewModelId) return c.json({ error: 'draft_model et review_model requis' }, 400);

    const settings = getRouterSettings();
    if (settings.strict_local_mode && (draftProvider !== 'local' || reviewProvider !== 'local')) {
      return c.json({ error: 'Mode strictement local actif — seuls les modèles locaux sont autorisés' }, 403);
    }

    const truncatedRequest = request.slice(0, MAX_REQUEST_CHARS);

    // ── Stage 1: draft ─────────────────────────────────────────────────────
    let draft;
    try {
      draft = await runAiTask({
        feature: 'prompt_generator', taskType: 'prompt_draft',
        preferredProvider: draftProvider, preferredModel: draftModelId,
        messages: buildDraftMessages(truncatedRequest), client: ollamaClient,
        requiredCapabilities: ['text'], logger,
      });
    } catch (err) {
      logger?.warn({ err: err.message }, 'prompt-generator: draft failed');
      if (draftProvider !== 'local') {
        return c.json({ error: `Échec du modèle cloud de rédaction (${err.message}) — vous pouvez relancer en local`, cloud_failed: true }, 502);
      }
      return c.json({ error: `Échec de la rédaction : ${err.message}` }, 503);
    }

    // ── Stage 2: review ────────────────────────────────────────────────────
    let review;
    try {
      review = await runAiTask({
        feature: 'prompt_generator', taskType: 'prompt_review',
        preferredProvider: reviewProvider, preferredModel: reviewModelId,
        messages: buildReviewMessages(draft.text.trim()), client: ollamaClient,
        requiredCapabilities: ['text'], logger,
      });
    } catch (err) {
      logger?.warn({ err: err.message }, 'prompt-generator: review failed');
      if (reviewProvider !== 'local') {
        return c.json({ error: `Échec du modèle cloud de relecture (${err.message}) — vous pouvez relancer en local`, cloud_failed: true, draft_text: draft.text.trim() }, 502);
      }
      return c.json({ error: `Échec de la relecture : ${err.message}` }, 503);
    }

    const parsed = parseReviewOutput(review.text.trim(), draft.text.trim());

    const id = crypto.randomUUID();
    insertGeneratedPrompt({
      id,
      request: truncatedRequest,
      draft_model: draft.model,
      draft_provider: draft.provider,
      draft_text: draft.text.trim(),
      review_model: review.model,
      review_provider: review.provider,
      reviewed_text: parsed.reviewedText,
      changes_explained: parsed.changesExplained,
      unchanged: parsed.unchanged,
      kept_version: null,
      outcome: 'untested',
      is_template: false,
    });

    return c.json({ prompt: getGeneratedPromptById(id) }, 201);
  });

  // ── POST /prompt-generator/:id/regenerate — rerun with (possibly new) models ─
  route.post('/prompt-generator/:id/regenerate', async (c) => {
    const existing = getGeneratedPromptById(c.req.param('id'));
    if (!existing) return c.json({ error: 'Prompt introuvable' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const draftModelId   = String(body?.draft_model ?? existing.draft_model).trim();
    const reviewModelId  = String(body?.review_model ?? existing.review_model).trim();
    const draftProvider  = body?.draft_provider ?? existing.draft_provider;
    const reviewProvider = body?.review_provider ?? existing.review_provider;

    const settings = getRouterSettings();
    if (settings.strict_local_mode && (draftProvider !== 'local' || reviewProvider !== 'local')) {
      return c.json({ error: 'Mode strictement local actif — seuls les modèles locaux sont autorisés' }, 403);
    }

    let draft, review;
    try {
      draft = await runAiTask({
        feature: 'prompt_generator', taskType: 'prompt_draft',
        preferredProvider: draftProvider, preferredModel: draftModelId,
        messages: buildDraftMessages(existing.request), client: ollamaClient, requiredCapabilities: ['text'], logger,
      });
      review = await runAiTask({
        feature: 'prompt_generator', taskType: 'prompt_review',
        preferredProvider: reviewProvider, preferredModel: reviewModelId,
        messages: buildReviewMessages(draft.text.trim()), client: ollamaClient, requiredCapabilities: ['text'], logger,
      });
    } catch (err) {
      logger?.warn({ err: err.message }, 'prompt-generator: regenerate failed');
      return c.json({ error: `Échec de la régénération : ${err.message}` }, 503);
    }

    const parsed = parseReviewOutput(review.text.trim(), draft.text.trim());
    const id = crypto.randomUUID();
    insertGeneratedPrompt({
      id,
      request: existing.request,
      draft_model: draft.model,
      draft_provider: draft.provider,
      draft_text: draft.text.trim(),
      review_model: review.model,
      review_provider: review.provider,
      reviewed_text: parsed.reviewedText,
      changes_explained: parsed.changesExplained,
      unchanged: parsed.unchanged,
      kept_version: null,
      outcome: 'untested',
      is_template: false,
    });

    return c.json({ prompt: getGeneratedPromptById(id) }, 201);
  });

  // ── PUT /prompt-generator/:id — update kept_version, outcome, is_template ──
  route.put('/prompt-generator/:id', async (c) => {
    const id = c.req.param('id');
    if (!getGeneratedPromptById(id)) return c.json({ error: 'Prompt introuvable' }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body requis' }, 400);

    const updates = {};
    if (body.kept_version !== undefined) updates.kept_version = body.kept_version;
    if (body.outcome      !== undefined) updates.outcome      = body.outcome;
    if (body.is_template  !== undefined) updates.is_template  = !!body.is_template;

    updateGeneratedPrompt(id, updates);
    return c.json({ prompt: getGeneratedPromptById(id) });
  });

  // ── DELETE /prompt-generator/:id ────────────────────────────────────────────
  route.delete('/prompt-generator/:id', (c) => {
    const id = c.req.param('id');
    if (!getGeneratedPromptById(id)) return c.json({ error: 'Prompt introuvable' }, 404);
    deleteGeneratedPrompt(id);
    return c.json({ ok: true });
  });

  // ── GET /prompt-generator/export/all — export all as JSON ──────────────────
  route.get('/prompt-generator/export/all', (c) => {
    const prompts = getAllGeneratedPrompts({});
    return new Response(JSON.stringify({ __docteur_prompts_version: 1, prompts }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="docteur-prompts.json"',
      },
    });
  });

  // ── POST /prompt-generator/import — import from JSON ────────────────────────
  route.post('/prompt-generator/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || body.__docteur_prompts_version !== 1 || !Array.isArray(body.prompts)) {
      return c.json({ error: 'Format invalide — fichier JSON de prompts Docteur attendu' }, 400);
    }

    let imported = 0;
    const errors = [];
    for (const p of body.prompts) {
      if (!p?.request || !p?.draft_text) continue;
      if (countGeneratedPrompts() >= MAX_PROMPTS) break;
      try {
        insertGeneratedPrompt({
          id: crypto.randomUUID(),
          request: p.request,
          draft_model: p.draft_model ?? 'inconnu',
          draft_provider: p.draft_provider ?? 'local',
          draft_text: p.draft_text ?? '',
          review_model: p.review_model ?? 'inconnu',
          review_provider: p.review_provider ?? 'local',
          reviewed_text: p.reviewed_text ?? '',
          changes_explained: p.changes_explained ?? '',
          unchanged: !!p.unchanged,
          kept_version: p.kept_version ?? null,
          outcome: p.outcome ?? 'untested',
          is_template: !!p.is_template,
        });
        imported++;
      } catch (err) {
        errors.push({ request: p.request?.slice(0, 60), error: err.message });
      }
    }

    return c.json({ ok: true, imported, total: body.prompts.length, errors });
  });

  // ── POST /prompt-generator/:id/send — record a send event ──────────────────
  route.post('/prompt-generator/:id/send', async (c) => {
    const id = c.req.param('id');
    if (!getGeneratedPromptById(id)) return c.json({ error: 'Prompt introuvable' }, 404);

    const body = await c.req.json().catch(() => null);
    const destinationId = String(body?.destinationId ?? '').trim();
    if (!destinationId) return c.json({ error: 'destinationId requis' }, 400);

    const destination = getPromptDestinations().find(d => d.id === destinationId);
    if (!destination) return c.json({ error: 'Destination introuvable' }, 404);

    const event = recordPromptSendEvent({
      generatedPromptId: id,
      destinationId,
      destinationName: destination.name,
      prefillUsed: !!body?.prefillUsed,
    });
    return c.json({ event, events: getPromptSendEventsForGeneration(id) }, 201);
  });

  // ── GET /prompt-generator/:id/send-events — send history for a generation ──
  route.get('/prompt-generator/:id/send-events', (c) => {
    const id = c.req.param('id');
    if (!getGeneratedPromptById(id)) return c.json({ error: 'Prompt introuvable' }, 404);
    return c.json({ events: getPromptSendEventsForGeneration(id) });
  });

  return route;
}
