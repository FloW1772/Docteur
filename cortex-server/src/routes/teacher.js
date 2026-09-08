import { Hono } from 'hono';
import { chatCompletion, getInstalledModels } from '../lib/ollama.js';
import * as groqProvider from '../lib/providers/groq.js';
import * as geminiProvider from '../lib/providers/gemini.js';
import * as openrouterProvider from '../lib/providers/openrouter.js';
import {
  getRouterSettings, getCloudKeys,
  getTeacherSettings, setTeacherSettings,
  incrementTeacherModelUsage, getTeacherModelUsageToday,
  insertLearningPath, updateLearningPath, getLearningPathById, getAllLearningPaths, deleteLearningPath,
  insertLearningPathStep, updateLearningPathStep, getStepsByPathId, getLearningPathStepById,
  insertReviewItem, updateReviewItem, getReviewItemById, getDueReviewItems, countDueReviewItems,
  insertReviewAttempt, getReviewStats, deleteReviewItem,
} from '../lib/sqlite.js';
import { normalizeTeacherRegister, teacherRegisterInstruction, TEACHER_REGISTERS, TEACHER_REGISTER_LABELS } from '../lib/teacher-register.js';

const STRICT_LOCAL_ERROR = {
  error: 'Mode strictement local activé — le modèle Professeur configuré est un modèle cloud, désactivé pour le moment. Choisis un modèle local dans Paramètres.',
  strict_local: true,
};

// Limites quotidiennes connues et vérifiées pour quelques modèles Groq courants.
// Ne PAS inventer de limite pour un modèle non listé ici — dans ce cas on
// affiche seulement le compteur d'appels du jour, sans "quota restant".
const GROQ_DAILY_LIMITS = {
  'llama-3.1-8b-instant': 14_400,
};

const DEFAULT_TEACHER_MODEL = 'groq:llama-3.1-8b-instant';

// Modèles Groq connus/proposés dans le picker Professeur. On réutilise ici le
// modèle par défaut du router général (DEFAULT_MODEL de providers/groq.js) et
// les modèles pour lesquels on connaît une limite quotidienne (GROQ_DAILY_LIMITS)
// — pas de liste inventée : uniquement des modèles déjà référencés ailleurs
// dans ce codebase.
function knownGroqModels() {
  const ids = new Set([groqProvider.DEFAULT_MODEL, ...Object.keys(GROQ_DAILY_LIMITS)]);
  return Array.from(ids);
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} Go`;
  const mb = bytes / (1024 ** 2);
  return `${Math.round(mb)} Mo`;
}

function parseModelId(modelId) {
  if (!modelId || modelId === 'local') return { provider: 'local', model: 'local' };
  if (modelId.startsWith('groq:')) return { provider: 'groq', model: modelId.slice('groq:'.length) };
  if (modelId.startsWith('gemini:')) return { provider: 'gemini', model: modelId.slice('gemini:'.length) };
  if (modelId.startsWith('openrouter:')) return { provider: 'openrouter', model: modelId.slice('openrouter:'.length) };
  return { provider: 'local', model: modelId };
}

function resolveEffectiveTeacherModel() {
  const settings = getTeacherSettings();
  const strictLocal = getRouterSettings()?.strict_local_mode === true;
  const requested = settings.model || DEFAULT_TEACHER_MODEL;
  const { provider } = parseModelId(requested);
  if (strictLocal && provider !== 'local') {
    return { modelId: 'local', provider: 'local', forcedLocal: true };
  }
  return { modelId: requested, provider, forcedLocal: false };
}

async function callTeacherModel({ messages, ollamaClient }) {
  const { modelId, provider, forcedLocal } = resolveEffectiveTeacherModel();

  if (provider === 'local') {
    const localModel = getRouterSettings()?.chat_model ?? 'mistral-nemo:12b-instruct-2407-q4_K_M';
    const text = await chatCompletion(ollamaClient, localModel, messages);
    incrementTeacherModelUsage('local');
    return { text, model: `local/${localModel}`, provider: 'local', forcedLocal };
  }

  if (provider === 'groq') {
    const keys = getCloudKeys();
    if (!keys.groq_key) {
      const e = new Error('Clé Groq non configurée — configure-la dans Paramètres pour utiliser un modèle Professeur cloud.');
      throw e;
    }
    const { model } = parseModelId(modelId);
    try {
      const result = await groqProvider.complete({ apiKey: keys.groq_key, messages, model });
      incrementTeacherModelUsage(model);
      return { text: result.text, model: result.model, provider: 'groq', forcedLocal };
    } catch (err) {
      if (err.isQuota) {
        const e = new Error(`Quota Groq atteint pour ce modèle (${model}) — réessaie plus tard ou choisis un autre modèle Professeur dans Paramètres.`);
        e.isQuota = true;
        throw e;
      }
      throw err;
    }
  }

  if (provider === 'gemini') {
    const keys = getCloudKeys();
    if (!keys.gemini_key) {
      const e = new Error('Clé Gemini non configurée — configure-la dans Paramètres pour utiliser un modèle Professeur cloud.');
      throw e;
    }
    try {
      const result = await geminiProvider.completeWithCascade({ apiKey: keys.gemini_key, messages });
      incrementTeacherModelUsage(`gemini:${result.model}`);
      return { text: result.text, model: `gemini/${result.model}`, provider: 'gemini', forcedLocal };
    } catch (err) {
      if (err.isQuota) {
        const e = new Error('Quota Gemini atteint sur tous les modèles de la cascade — réessaie plus tard ou choisis un autre modèle Professeur dans Paramètres.');
        e.isQuota = true;
        throw e;
      }
      throw err;
    }
  }

  if (provider === 'openrouter') {
    const keys = getCloudKeys();
    if (!keys.openrouter_key) {
      const e = new Error('Clé OpenRouter non configurée — configure-la dans Paramètres pour utiliser un modèle Professeur cloud.');
      throw e;
    }
    try {
      const result = await openrouterProvider.complete({ apiKey: keys.openrouter_key, messages });
      incrementTeacherModelUsage(`openrouter:${openrouterProvider.FREE_MODEL}`);
      return { text: result.text, model: result.model, provider: 'openrouter', forcedLocal };
    } catch (err) {
      if (err.isQuota) {
        const e = new Error(`Quota OpenRouter atteint pour le modèle gratuit (${openrouterProvider.FREE_MODEL}) — réessaie plus tard ou choisis un autre modèle Professeur dans Paramètres.`);
        e.isQuota = true;
        throw e;
      }
      throw err;
    }
  }

  throw new Error(`Provider Professeur inconnu : ${provider}`);
}

function buildTeacherQuotaInfo() {
  const settings = getTeacherSettings();
  const { provider, model } = parseModelId(settings.model || DEFAULT_TEACHER_MODEL);

  if (provider === 'local') {
    return { model: settings.model || 'local', provider: 'local', used_today: null, limit: null, remaining: null, unlimited_local: true };
  }

  const usageKey = provider === 'groq' ? model : `${provider}:${model}`;
  const usedToday = getTeacherModelUsageToday(usageKey);
  const limit = provider === 'groq' ? (GROQ_DAILY_LIMITS[model] ?? null) : null;
  return {
    model: settings.model,
    provider,
    used_today: usedToday,
    limit,
    remaining: limit != null ? Math.max(0, limit - usedToday) : null,
    unlimited_local: false,
  };
}

// ── Neurones : citation de sources pertinentes pour une étape ────────────────

async function findRelevantNeurons(services, query) {
  if (!services?.searchNeurons) return [];
  try {
    const result = await services.searchNeurons({ query, limit: 4, threshold: 0.3, filter_by_kind: [] });
    // Never cite private neurons (cv, candidature, user-marked private) in the
    // Professeur prompt — this prompt can be sent to a cloud model (Groq) when
    // strict_local_mode is off, so private content must be excluded here at
    // the source rather than relying solely on the provider-level sentinel guard.
    return (result?.results ?? []).filter(n => n.private !== true);
  } catch { return []; }
}

function buildNeuronCitationBlock(neurons) {
  if (!neurons || neurons.length === 0) return '';
  const items = neurons
    .map((n, i) => `--- Neurone ${i + 1} : "${n.title}" (${n.kind}) ---\n${n.content_preview}`)
    .join('\n\n');
  return `\n\nVoici des neurones existants de l'utilisateur qui peuvent être pertinents pour ce sujet — appuie-toi dessus si c'est utile et CITE-LES PAR LEUR TITRE quand tu le fais (ne les invente pas, ne les cite pas si tu ne t'en sers pas) :\n\n${items}`;
}

// ── Prompt builders ────────────────────────────────────────────────────────

function buildPlanPrompt(subject, register) {
  return [
    { role: 'system', content: `Tu es un professeur qui conçoit un plan d'apprentissage. ${teacherRegisterInstruction(register)}\n\nRéponds UNIQUEMENT avec un JSON valide : un tableau d'étapes, du plus simple au plus complexe, chaque étape ayant "title" (titre court) et "summary" (une phrase décrivant ce qui sera appris). Entre 4 et 8 étapes. Aucun texte hors du JSON.` },
    { role: 'user', content: `Construis un plan d'apprentissage pas-à-pas pour ce sujet : "${subject}"` },
  ];
}

function buildStepExplanationPrompt({ subject, register, step, neuronBlock }) {
  return [
    { role: 'system', content: `Tu es un professeur qui enseigne "${subject}" étape par étape. ${teacherRegisterInstruction(register)}${neuronBlock}` },
    { role: 'user', content: `Explique cette étape : "${step.title}" (${step.summary ?? ''}). Termine ton explication par UNE question de compréhension simple pour vérifier que l'étape est comprise avant de passer à la suite.` },
  ];
}

function buildComprehensionEvalPrompt({ subject, register, step, exchange, userAnswer }) {
  const history = exchange.map(e => `Q: ${e.question}\nRéponse utilisateur: ${e.answer}\nÉvaluation: ${e.evaluation ?? ''}`).join('\n\n');
  return [
    { role: 'system', content: `Tu es un professeur qui enseigne "${subject}". ${teacherRegisterInstruction(register)}\n\nTu viens de poser une question de compréhension sur l'étape "${step.title}". Évalue la réponse de l'utilisateur avec pédagogie : si elle montre une compréhension suffisante, confirme-le clairement et dis que l'étape est validée (inclus le mot "VALIDÉ" quelque part dans ta réponse). Si elle montre une incompréhension ou une erreur, corrige avec bienveillance, réexplique le point flou, et repose une question pour vérifier à nouveau (n'inclus PAS le mot "VALIDÉ").` },
    ...(history ? [{ role: 'system', content: `Historique de l'échange sur cette étape :\n${history}` }] : []),
    { role: 'user', content: `Réponse de l'utilisateur à la dernière question : "${userAnswer}"` },
  ];
}

function buildRecapPrompt(subject, register, steps) {
  const stepsText = steps.map(s => `## ${s.title}\n${s.content}`).join('\n\n');
  return [
    { role: 'system', content: `Tu es un professeur qui rédige une fiche de synthèse à partir d'un parcours d'apprentissage terminé. ${teacherRegisterInstruction(register)}` },
    { role: 'user', content: `Rédige une fiche de synthèse claire et structurée (Markdown) résumant ce qui a été appris sur "${subject}", à partir de ces étapes :\n\n${stepsText}` },
  ];
}

function buildReviewQuestionsPrompt(subject, stepsText) {
  return [
    { role: 'system', content: 'Tu génères des questions de révision espacée à partir d\'un contenu appris. Réponds UNIQUEMENT avec un JSON valide : un tableau d\'objets {"question": "...", "answer_hint": "..."}. 2 à 4 questions maximum, qui testent la compréhension réelle, pas du par-cœur littéral.' },
    { role: 'user', content: `Sujet : "${subject}"\n\nContenu :\n${stepsText}` },
  ];
}

function buildReviewEvalPrompt(question, answerHint, userAnswer) {
  return [
    { role: 'system', content: `Tu évalues une réponse de révision espacée. Question posée : "${question}". Piste de réponse attendue (pour toi seulement, ne la recopie pas telle quelle) : "${answerHint}".\n\nRéponds UNIQUEMENT avec un JSON valide : {"correct": true|false, "feedback": "un court retour pédagogique en français"}. "correct" doit être true seulement si la réponse démontre une compréhension suffisante du fond, pas une correspondance mot pour mot.` },
    { role: 'user', content: `Réponse de l'utilisateur : "${userAnswer}"` },
  ];
}

function stripMarkdownFences(text) {
  // Modèles locaux répondent souvent avec ```json ... ``` ou ``` ... ``` malgré
  // la consigne "JSON uniquement" — on retire les fences avant de tenter le parse.
  return String(text ?? '').replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
}

function tryParseJson(text) {
  const candidates = [text, stripMarkdownFences(text)];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    try {
      const start = candidate.search(/[[{]/);
      const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
      const slice = (start >= 0 && end > start) ? candidate.slice(start, end + 1) : candidate;
      const parsed = JSON.parse(slice);
      return parsed;
    } catch { /* try next candidate */ }
  }
  return null;
}

// Tente de générer un plan/JSON exploitable : un essai normal, puis si le
// parsing échoue, UN SEUL retour au modèle lui demandant explicitement de
// reformuler en JSON strict sans commentaire ni fences. Pas de boucle infinie.
async function callTeacherModelForJson({ messages, ollamaClient, logger, label }) {
  const first = await callTeacherModel({ messages, ollamaClient });
  const firstParsed = tryParseJson(first.text);
  if (firstParsed !== null) return { result: first, parsed: firstParsed };

  logger?.warn({ model: first.model, raw: first.text?.slice(0, 500) }, `teacher: ${label} — réponse non-JSON, tentative de reformulation`);

  const retryMessages = [
    ...messages,
    { role: 'assistant', content: first.text },
    { role: 'user', content: 'Ta réponse précédente n\'était pas un JSON valide. Réponds à nouveau, UNIQUEMENT avec le JSON demandé, sans aucun texte avant/après, sans balises markdown ni ```.' },
  ];
  const retry = await callTeacherModel({ messages: retryMessages, ollamaClient });
  const retryParsed = tryParseJson(retry.text);
  if (retryParsed !== null) return { result: retry, parsed: retryParsed };

  logger?.error({ model: retry.model, raw: retry.text?.slice(0, 500) }, `teacher: ${label} — échec du parsing JSON même après reformulation`);
  return { result: retry, parsed: null };
}

// ── Algorithme de répétition espacée (variante simplifiée de SM-2) ──────────
// Sur bonne réponse : l'intervalle grandit proportionnellement au facteur de
// facilité (ease_factor), qui lui-même augmente légèrement à chaque succès
// (plafonné à 3.0) — plus une notion est maîtrisée, plus les révisions
// s'espacent vite. Sur mauvaise réponse : on revient à un intervalle court
// (1 jour) et on réduit l'ease_factor (plancher 1.3) pour que les notions qui
// résistent reviennent plus souvent tant qu'elles ne sont pas acquises.
function computeNextSchedule({ ease_factor, interval_days }, wasCorrect) {
  if (wasCorrect) {
    const nextEase = Math.min(ease_factor + 0.1, 3.0);
    const nextInterval = Math.max(1, Math.round(interval_days * nextEase));
    return { ease_factor: nextEase, interval_days: nextInterval };
  }
  return { ease_factor: Math.max(ease_factor - 0.2, 1.3), interval_days: 1 };
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function createTeacherRoute({ services, ollamaClient, logger }) {
  const route = new Hono();

  // ── Réglages ───────────────────────────────────────────────────────────
  route.get('/teacher/settings', (c) => c.json(getTeacherSettings()));

  route.post('/teacher/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body requis' }, 400);
    const updates = {};
    if (body.model !== undefined) updates.model = String(body.model);
    if (body.defaultRegister !== undefined) updates.defaultRegister = normalizeTeacherRegister(body.defaultRegister);
    setTeacherSettings(updates);
    return c.json(getTeacherSettings());
  });

  route.get('/teacher/quota', (c) => c.json(buildTeacherQuotaInfo()));

  // ── Modèles disponibles pour le picker Professeur ───────────────────────
  route.get('/teacher/available-models', async (c) => {
    const strictLocal = getRouterSettings()?.strict_local_mode === true;

    let local = { available: false, reason: null, models: [] };
    try {
      const installed = await getInstalledModels(ollamaClient);
      local = {
        available: true,
        reason: null,
        models: installed.map(m => ({ id: m.name, size_bytes: m.size ?? null, size_label: humanSize(m.size) })),
      };
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack }, 'teacher: available-models — Ollama injoignable');
      local = { available: false, reason: 'Ollama injoignable', models: [] };
    }

    const keys = getCloudKeys();
    const groqConfigured = !!keys.groq_key;
    const geminiConfigured = !!keys.gemini_key;
    const openrouterConfigured = !!keys.openrouter_key;
    const usageCache = {};
    const groqModels = knownGroqModels().map(id => {
      const usedToday = groqConfigured ? (usageCache[id] ??= getTeacherModelUsageToday(id)) : null;
      const limit = GROQ_DAILY_LIMITS[id] ?? null;
      return {
        id,
        configured: groqConfigured,
        disabled_reason: !groqConfigured
          ? 'Clé non configurée — ajoute-la dans Paramètres > Fournisseurs cloud'
          : (strictLocal ? 'Mode strictement local actif — les modèles cloud sont désactivés' : null),
        used_today: groqConfigured ? usedToday : null,
        limit,
        remaining: (groqConfigured && limit != null) ? Math.max(0, limit - usedToday) : null,
      };
    });

    // Gemini : pas de limite quotidienne connue/vérifiée par modèle dans ce
    // codebase (pas d'équivalent GROQ_DAILY_LIMITS pour Gemini) — on affiche
    // donc limit/remaining/used_today à null plutôt que d'inventer un chiffre.
    const geminiModels = geminiProvider.GEMINI_CASCADE.map(id => ({
      id: `gemini:${id}`,
      configured: geminiConfigured,
      disabled_reason: !geminiConfigured
        ? 'Clé non configurée — ajoute-la dans Paramètres > Fournisseurs cloud'
        : (strictLocal ? 'Mode strictement local actif — les modèles cloud sont désactivés' : null),
      used_today: null,
      limit: null,
      remaining: null,
    }));

    // OpenRouter : un seul modèle gratuit fixe (voir providers/openrouter.js)
    // — pas de vraie sélection possible, on ne propose donc qu'une seule
    // option plutôt que d'inventer une liste de modèles inexistants.
    const openrouterModels = [{
      id: `openrouter:${openrouterProvider.FREE_MODEL}`,
      configured: openrouterConfigured,
      disabled_reason: !openrouterConfigured
        ? 'Clé non configurée — ajoute-la dans Paramètres > Fournisseurs cloud'
        : (strictLocal ? 'Mode strictement local actif — les modèles cloud sont désactivés' : null),
      used_today: null,
      limit: null,
      remaining: null,
    }];

    return c.json({
      strict_local_mode: strictLocal,
      local,
      cloud: {
        groq: { available: groqConfigured && !strictLocal, configured: groqConfigured, models: groqModels },
        gemini: { available: geminiConfigured && !strictLocal, configured: geminiConfigured, models: geminiModels },
        openrouter: { available: openrouterConfigured && !strictLocal, configured: openrouterConfigured, models: openrouterModels },
      },
    });
  });

  route.post('/teacher/settings/validate', async (c) => {
    const body = await c.req.json().catch(() => null);
    const model = String(body?.model ?? '').trim();
    if (!model) return c.json({ ok: false, error: 'model requis' }, 400);

    const { provider, model: resolvedModel } = parseModelId(model);
    const strictLocal = getRouterSettings()?.strict_local_mode === true;
    if (strictLocal && provider !== 'local') {
      return c.json({ ok: false, error: 'Mode strictement local actif — impossible de valider un modèle cloud pour le moment.' });
    }

    try {
      if (provider === 'local') {
        const localModel = model === 'local'
          ? (getRouterSettings()?.chat_model ?? 'mistral-nemo:12b-instruct-2407-q4_K_M')
          : resolvedModel;
        const installed = await getInstalledModels(ollamaClient);
        const isInstalled = installed.some(m => m.name === localModel || m.name.startsWith(`${localModel}:`));
        if (!isInstalled) {
          return c.json({ ok: false, error: `Modèle local "${localModel}" introuvable dans Ollama — vérifie qu'il est bien installé (ollama pull ${localModel}).` });
        }
        await chatCompletion(ollamaClient, localModel, [{ role: 'user', content: 'Réponds juste "OK".' }]);
        return c.json({ ok: true });
      }

      if (provider === 'groq') {
        const keys = getCloudKeys();
        if (!keys.groq_key) {
          return c.json({ ok: false, error: 'Clé Groq non configurée — configure-la dans Paramètres > Fournisseurs cloud.' });
        }
        await groqProvider.testKey(keys.groq_key, resolvedModel);
        return c.json({ ok: true });
      }

      if (provider === 'gemini') {
        const keys = getCloudKeys();
        if (!keys.gemini_key) {
          return c.json({ ok: false, error: 'Clé Gemini non configurée — configure-la dans Paramètres > Fournisseurs cloud.' });
        }
        await geminiProvider.testKey(keys.gemini_key);
        return c.json({ ok: true });
      }

      if (provider === 'openrouter') {
        const keys = getCloudKeys();
        if (!keys.openrouter_key) {
          return c.json({ ok: false, error: 'Clé OpenRouter non configurée — configure-la dans Paramètres > Fournisseurs cloud.' });
        }
        await openrouterProvider.testKey(keys.openrouter_key);
        return c.json({ ok: true });
      }

      return c.json({ ok: false, error: `Provider inconnu pour le modèle "${model}".` });
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack, model }, 'teacher: settings validation failed');
      return c.json({ ok: false, error: err.message });
    }
  });

  route.get('/teacher/registers', (c) => c.json({
    registers: TEACHER_REGISTERS.map(r => ({ id: r, label: TEACHER_REGISTER_LABELS[r] })),
  }));

  // ── Parcours — création (plan) ────────────────────────────────────────
  route.post('/teacher/paths', async (c) => {
    const body = await c.req.json().catch(() => null);
    const subject = String(body?.subject ?? '').trim();
    if (!subject) return c.json({ error: 'subject requis' }, 400);
    const register = normalizeTeacherRegister(body?.register ?? getTeacherSettings().defaultRegister);

    let planResult;
    let plan;
    try {
      const { result, parsed } = await callTeacherModelForJson({
        messages: buildPlanPrompt(subject, register), ollamaClient, logger, label: 'plan generation',
      });
      planResult = result;
      plan = parsed;
    } catch (err) {
      logger?.error({ err: err.message, stack: err.stack }, 'teacher: plan generation failed');
      if (err.isQuota) return c.json({ error: err.message, quota_hit: true }, 429);
      return c.json({ error: `Échec de la génération du plan : ${err.message}` }, 503);
    }

    if (!Array.isArray(plan) || plan.length === 0) {
      logger?.error({ model: planResult.model, raw: planResult.text?.slice(0, 1000) }, 'teacher: plan JSON unusable after retry');
      return c.json({
        error: `Le modèle "${planResult.model}" n'a pas produit de plan exploitable après une tentative de reformulation. Essaie un autre modèle Professeur dans Paramètres, ou reformule ton sujet.`,
      }, 503);
    }
    const cleanPlan = plan
      .filter(s => s?.title)
      .map(s => ({ title: String(s.title).trim(), summary: String(s.summary ?? '').trim() }));

    const id = crypto.randomUUID();
    insertLearningPath({
      id, subject, register,
      teacher_model: planResult.model,
      status: 'planning',
      plan: cleanPlan,
    });

    return c.json({ path: getLearningPathById(id), model_used: planResult.model, forced_local: planResult.forcedLocal }, 201);
  });

  // ── Parcours — ajuster le plan avant de commencer ───────────────────────
  route.put('/teacher/paths/:id/plan', async (c) => {
    const id = c.req.param('id');
    const path = getLearningPathById(id);
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    if (path.status !== 'planning') return c.json({ error: 'Le plan ne peut plus être modifié — le parcours a déjà commencé' }, 409);

    const body = await c.req.json().catch(() => null);
    const plan = Array.isArray(body?.plan) ? body.plan : null;
    if (!plan || plan.length === 0) return c.json({ error: 'plan (tableau non vide) requis' }, 400);
    const cleanPlan = plan
      .filter(s => s?.title)
      .map(s => ({ title: String(s.title).trim(), summary: String(s.summary ?? '').trim() }));

    updateLearningPath(id, { plan: cleanPlan });
    return c.json({ path: getLearningPathById(id) });
  });

  // ── Parcours — démarrer (crée les steps depuis le plan validé) ─────────
  route.post('/teacher/paths/:id/start', async (c) => {
    const id = c.req.param('id');
    const path = getLearningPathById(id);
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    if (path.status !== 'planning') return c.json({ error: 'Ce parcours a déjà démarré' }, 409);
    if (!path.plan?.length) return c.json({ error: 'Le plan est vide' }, 400);

    path.plan.forEach((step, index) => {
      insertLearningPathStep({
        id: crypto.randomUUID(),
        path_id: id,
        step_index: index,
        title: step.title,
        status: index === 0 ? 'active' : 'pending',
      });
    });

    updateLearningPath(id, { status: 'active', current_step_index: 0 });
    return c.json({ path: getLearningPathById(id), steps: getStepsByPathId(id) });
  });

  // ── Parcours — liste et détail ───────────────────────────────────────
  route.get('/teacher/paths', (c) => {
    const status = c.req.query('status') || undefined;
    return c.json({ paths: getAllLearningPaths({ status }) });
  });

  route.get('/teacher/paths/:id', (c) => {
    const path = getLearningPathById(c.req.param('id'));
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    return c.json({ path, steps: getStepsByPathId(path.id) });
  });

  route.delete('/teacher/paths/:id', (c) => {
    const id = c.req.param('id');
    if (!getLearningPathById(id)) return c.json({ error: 'Parcours introuvable' }, 404);
    deleteLearningPath(id);
    return c.json({ ok: true });
  });

  route.post('/teacher/paths/:id/abandon', (c) => {
    const id = c.req.param('id');
    if (!getLearningPathById(id)) return c.json({ error: 'Parcours introuvable' }, 404);
    updateLearningPath(id, { status: 'abandoned' });
    return c.json({ path: getLearningPathById(id) });
  });

  // ── Étape — obtenir/générer l'explication d'une étape ───────────────────
  route.post('/teacher/paths/:id/steps/:stepId/explain', async (c) => {
    const path = getLearningPathById(c.req.param('id'));
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    const step = getLearningPathStepById(c.req.param('stepId'));
    if (!step || step.path_id !== path.id) return c.json({ error: 'Étape introuvable' }, 404);

    if (step.content) {
      return c.json({ step, model_used: path.teacher_model, cached: true });
    }

    const neurons = await findRelevantNeurons(services, `${path.subject} — ${step.title}`);
    const neuronBlock = buildNeuronCitationBlock(neurons);

    let result;
    try {
      result = await callTeacherModel({
        messages: buildStepExplanationPrompt({ subject: path.subject, register: path.register, step, neuronBlock }),
        ollamaClient,
      });
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack }, 'teacher: step explanation failed');
      if (err.isQuota) return c.json({ error: err.message, quota_hit: true }, 429);
      return c.json({ error: `Échec de l'explication : ${err.message}` }, 503);
    }

    updateLearningPathStep(step.id, { content: result.text.trim() });
    return c.json({
      step: getLearningPathStepById(step.id),
      model_used: result.model,
      forced_local: result.forcedLocal,
      sources_used: neurons.map(n => ({ id: n.id, title: n.title })),
    });
  });

  // ── Étape — répondre à la question de compréhension ─────────────────────
  route.post('/teacher/paths/:id/steps/:stepId/answer', async (c) => {
    const path = getLearningPathById(c.req.param('id'));
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    const step = getLearningPathStepById(c.req.param('stepId'));
    if (!step || step.path_id !== path.id) return c.json({ error: 'Étape introuvable' }, 404);

    const body = await c.req.json().catch(() => null);
    const userAnswer = String(body?.answer ?? '').trim();
    if (!userAnswer) return c.json({ error: 'answer requis' }, 400);

    // La dernière question posée est la dernière ligne du contenu de l'étape,
    // ou la dernière évaluation si l'échange a déjà commencé.
    const exchange = step.comprehension_check ?? [];
    const lastQuestion = exchange.length > 0
      ? exchange[exchange.length - 1].reask ?? exchange[exchange.length - 1].question
      : step.content;

    let result;
    try {
      result = await callTeacherModel({
        messages: buildComprehensionEvalPrompt({ subject: path.subject, register: path.register, step, exchange, userAnswer }),
        ollamaClient,
      });
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack }, 'teacher: comprehension eval failed');
      if (err.isQuota) return c.json({ error: err.message, quota_hit: true }, 429);
      return c.json({ error: `Échec de l'évaluation : ${err.message}` }, 503);
    }

    const evaluation = result.text.trim();
    const validated = /VALID[ÉE]/i.test(evaluation);

    const newExchange = [...exchange, { question: lastQuestion, answer: userAnswer, evaluation, reask: validated ? null : evaluation }];
    updateLearningPathStep(step.id, {
      comprehension_check: newExchange,
      status: validated ? 'done' : 'active',
    });

    return c.json({
      step: getLearningPathStepById(step.id),
      evaluation,
      validated,
      model_used: result.model,
      forced_local: result.forcedLocal,
    });
  });

  // ── Étape — avancer / revenir en arrière ─────────────────────────────────
  route.post('/teacher/paths/:id/steps/:stepId/advance', async (c) => {
    const path = getLearningPathById(c.req.param('id'));
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    const steps = getStepsByPathId(path.id);
    const step = steps.find(s => s.id === c.req.param('stepId'));
    if (!step) return c.json({ error: 'Étape introuvable' }, 404);

    updateLearningPathStep(step.id, { status: 'done' });
    const nextIndex = step.step_index + 1;
    const nextStep = steps.find(s => s.step_index === nextIndex);

    if (!nextStep) {
      updateLearningPath(path.id, { status: 'completed', completed_at: new Date().toISOString(), current_step_index: step.step_index });
      return c.json({ path: getLearningPathById(path.id), steps: getStepsByPathId(path.id), finished: true });
    }

    updateLearningPathStep(nextStep.id, { status: 'active' });
    updateLearningPath(path.id, { current_step_index: nextIndex });
    return c.json({ path: getLearningPathById(path.id), steps: getStepsByPathId(path.id), finished: false });
  });

  route.post('/teacher/paths/:id/steps/:stepId/back', (c) => {
    const path = getLearningPathById(c.req.param('id'));
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    const steps = getStepsByPathId(path.id);
    const step = steps.find(s => s.id === c.req.param('stepId'));
    if (!step) return c.json({ error: 'Étape introuvable' }, 404);

    const prevIndex = step.step_index - 1;
    const prevStep = steps.find(s => s.step_index === prevIndex);
    if (!prevStep) return c.json({ error: 'Déjà à la première étape' }, 409);

    updateLearningPathStep(step.id, { status: 'pending' });
    updateLearningPathStep(prevStep.id, { status: 'active' });
    updateLearningPath(path.id, { current_step_index: prevIndex, status: 'active' });
    return c.json({ path: getLearningPathById(path.id), steps: getStepsByPathId(path.id) });
  });

  // ── Parcours terminé — créer la fiche de synthèse (neurone recap) ───────
  route.post('/teacher/paths/:id/recap', async (c) => {
    const path = getLearningPathById(c.req.param('id'));
    if (!path) return c.json({ error: 'Parcours introuvable' }, 404);
    if (path.status !== 'completed') return c.json({ error: 'Le parcours n\'est pas terminé' }, 409);
    if (path.recap_neuron_id) return c.json({ error: 'Une fiche de synthèse existe déjà pour ce parcours', recap_neuron_id: path.recap_neuron_id }, 409);

    const steps = getStepsByPathId(path.id).filter(s => s.content);
    if (steps.length === 0) return c.json({ error: 'Aucun contenu à synthétiser' }, 400);

    let result;
    try {
      result = await callTeacherModel({ messages: buildRecapPrompt(path.subject, path.register, steps), ollamaClient });
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack }, 'teacher: recap generation failed');
      if (err.isQuota) return c.json({ error: err.message, quota_hit: true }, 429);
      return c.json({ error: `Échec de la génération de la fiche : ${err.message}` }, 503);
    }

    if (!services?.indexNeuron) return c.json({ error: 'Indexation des neurones indisponible' }, 503);
    const indexResult = await services.indexNeuron({
      title: `Apprentissage : ${path.subject}`,
      kind: 'reference',
      content: result.text.trim(),
      metadata: { source: 'teacher_recap', learning_path_id: path.id, register: path.register },
    });

    const neuronId = indexResult?.id ?? crypto.randomUUID();
    updateLearningPath(path.id, { recap_neuron_id: neuronId });

    // Génère aussi des questions de révision espacée à partir du contenu appris.
    let reviewItemsCreated = 0;
    try {
      const stepsText = steps.map(s => `## ${s.title}\n${s.content}`).join('\n\n');
      const qResult = await callTeacherModel({ messages: buildReviewQuestionsPrompt(path.subject, stepsText), ollamaClient });
      const questions = tryParseJson(qResult.text) ?? [];
      for (const q of questions) {
        if (!q?.question) continue;
        insertReviewItem({
          id: crypto.randomUUID(),
          source_type: 'path_step',
          source_id: path.id,
          question: String(q.question).trim(),
          answer_hint: String(q.answer_hint ?? '').trim(),
          next_review_at: addDays(1),
        });
        reviewItemsCreated++;
      }
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack }, 'teacher: review question generation failed (non-blocking)');
    }

    return c.json({ path: getLearningPathById(path.id), neuron_id: neuronId, review_items_created: reviewItemsCreated }, 201);
  });

  // ── Révision espacée — session du jour ───────────────────────────────────
  route.get('/teacher/review/due', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 5), 1), 50);
    return c.json({ items: getDueReviewItems(limit), count_due: countDueReviewItems() });
  });

  route.post('/teacher/review/:itemId/answer', async (c) => {
    const item = getReviewItemById(c.req.param('itemId'));
    if (!item) return c.json({ error: 'Élément de révision introuvable' }, 404);

    const body = await c.req.json().catch(() => null);
    const userAnswer = String(body?.answer ?? '').trim();
    if (!userAnswer) return c.json({ error: 'answer requis' }, 400);

    let evalResult;
    try {
      const result = await callTeacherModel({ messages: buildReviewEvalPrompt(item.question, item.answer_hint, userAnswer), ollamaClient });
      evalResult = tryParseJson(result.text) ?? { correct: false, feedback: result.text.trim() };
    } catch (err) {
      logger?.warn({ err: err.message, stack: err.stack }, 'teacher: review answer eval failed');
      if (err.isQuota) return c.json({ error: err.message, quota_hit: true }, 429);
      return c.json({ error: `Échec de l'évaluation : ${err.message}` }, 503);
    }

    const wasCorrect = evalResult.correct === true;
    const schedule = computeNextSchedule(item, wasCorrect);
    const nextReviewAt = addDays(schedule.interval_days);

    updateReviewItem(item.id, {
      ease_factor: schedule.ease_factor,
      interval_days: schedule.interval_days,
      next_review_at: nextReviewAt,
      last_reviewed_at: new Date().toISOString(),
      review_count: item.review_count + 1,
      success_count: item.success_count + (wasCorrect ? 1 : 0),
    });
    insertReviewAttempt({ id: crypto.randomUUID(), review_item_id: item.id, was_correct: wasCorrect, user_answer: userAnswer });

    return c.json({
      correct: wasCorrect,
      feedback: evalResult.feedback ?? '',
      next_review_at: nextReviewAt,
      interval_days: schedule.interval_days,
      item: getReviewItemById(item.id),
    });
  });

  route.delete('/teacher/review/:itemId', (c) => {
    const id = c.req.param('itemId');
    if (!getReviewItemById(id)) return c.json({ error: 'Élément introuvable' }, 404);
    deleteReviewItem(id);
    return c.json({ ok: true });
  });

  // ── Stats ─────────────────────────────────────────────────────────────
  route.get('/teacher/stats', (c) => {
    const stats = getReviewStats();
    const paths = getAllLearningPaths();
    return c.json({
      ...stats,
      paths_in_progress: paths.filter(p => p.status === 'active').length,
      paths_planning: paths.filter(p => p.status === 'planning').length,
      paths_completed: paths.filter(p => p.status === 'completed').length,
      paths_abandoned: paths.filter(p => p.status === 'abandoned').length,
    });
  });

  return route;
}
