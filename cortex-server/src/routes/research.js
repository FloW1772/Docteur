// POST /api/research — Veille / recherche IA via Gemini
// body: { subject: string, mode: 'synthese' | 'actualite' }
// returns: { content, model, mode, sources?, warning? }

import { Hono } from 'hono';
import {
  complete,
  completeWithCascade,
  completeWithGrounding,
  setGeminiRpm,
  DEFAULT_MODEL,
} from '../lib/providers/gemini.js';
import { getCloudKeys, getRouterSettings, getMeta, setMeta, insertActivityLog } from '../lib/sqlite.js';

// ── Grounding quota tracker (daily counter in SQLite) ─────────────────────────

const GROUNDING_DAILY_LIMIT = 20;

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getGroundingUsage() {
  const today = getTodayISO();
  if (getMeta('gemini_grounding_date', '') !== today) {
    setMeta('gemini_grounding_date', today);
    setMeta('gemini_grounding_used', 0);
    return 0;
  }
  return Number(getMeta('gemini_grounding_used', 0)) || 0;
}

function incrementGroundingUsage() {
  setMeta('gemini_grounding_used', getGroundingUsage() + 1);
}

// Models that support Google Search grounding on the free tier.
// gemini-3.1-flash-lite does NOT support the googleSearch tool.
const GROUNDING_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function synthesePrompt(subject) {
  return `Tu es un expert en veille stratégique et prospective. En te basant sur tes connaissances, produis une synthèse structurée en français sur le sujet suivant :

**${subject}**

## Vue d'ensemble
[3-5 phrases de contexte général]

## Concepts et thèmes clés
[5-8 points essentiels, avec explication brève de chacun]

## Acteurs principaux
[Organisations, entreprises, institutions ou personnes importantes dans ce domaine]

## Enjeux et tendances
[3-5 enjeux majeurs ou tendances actuelles]

## Pour aller plus loin
[2-3 pistes d'approfondissement ou questions ouvertes]

---
*Synthèse basée sur les connaissances de l'IA — informations à vérifier pour les données récentes.*`;
}

function actualitePrompt(subject) {
  return `Fais une recherche web et synthétise les actualités récentes (derniers mois) sur le sujet suivant :

**${subject}**

IMPÉRATIF : Pour chaque information importante, cite la source avec un lien cliquable au format [Titre de la source](URL). Ne mentionne que des faits avec une source web vérifiable. Si tu n'as pas de source récente fiable sur un point, dis-le clairement sans inventer.

## Actualités récentes
[Informations récentes avec sources — format : information ([Source](URL))]

## Points clés à retenir
[Synthèse des éléments importants]

## Contexte et perspective
[Mise en perspective avec le contexte plus large]

---
*Informations issues de la recherche web — vérifie les sources avant d'agir.*`;
}

const REVIEW_SEPARATOR_PREFIX = '--- RELECTURE CRITIQUE (IA,';

function reviewPrompt(content) {
  return `Relis cette veille de manière critique et honnête. Produis en français une section structurée :

1. **POINTS SOLIDES** : les affirmations bien appuyées par une source citée ou une connaissance établie
2. **POINTS À VÉRIFIER** : les affirmations avancées SANS source claire, ou qui pourraient être datées/incertaines
3. **CE QUI MANQUE** : angles, aspects ou informations qui mériteraient d'être approfondis

Sois honnête : si un point n'a pas de source, dis-le. Ne ré-affirme pas aveuglément le contenu, adopte un vrai regard critique.

Voici la veille :

${content}`;
}

const STRICT_LOCAL_ERROR = {
  error: 'Mode strictement local activé — la veille cloud est désactivée. Désactive-le dans Paramètres pour utiliser cette fonctionnalité.',
  strict_local: true,
};

export function createResearchRoute({ logger, fallbackChat }) {
  const app = new Hono();

  app.post('/research', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body    = await c.req.json().catch(() => ({}));
    const subject = String(body.subject ?? '').trim();
    const mode    = body.mode === 'actualite' ? 'actualite' : 'synthese';

    if (!subject) return c.json({ error: 'Sujet manquant' }, 400);
    if (subject.length > 500) return c.json({ error: 'Sujet trop long (max 500 caractères)' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) {
      return c.json({
        error: 'Clé Gemini non configurée. Ajoute-la dans Paramètres > Fournisseurs cloud.',
        no_key: true,
      }, 503);
    }

    // Apply the saved RPM limit
    const settings = getRouterSettings();
    setGeminiRpm(settings.gemini_rpm ?? 10);

    // ── Mode synthèse ──────────────────────────────────────────────────────────
    if (mode === 'synthese') {
      const prompt = synthesePrompt(subject);
      try {
        const result = await completeWithCascade({
          apiKey:    keys.gemini_key,
          messages:  [{ role: 'user', content: prompt }],
          maxTokens: 8192,
          logger,
        });
        logger?.info({ subject, model: result.model, mode }, 'research synthese done');
        insertActivityLog({ opType: 'veille', item: subject, result: 'success', modelUsed: result.model });
        return c.json({ content: result.text, model: result.model, mode, sources: [] });
      } catch (err) {
        logger?.warn({ subject, err: err.message }, 'research synthese failed');
        insertActivityLog({ opType: 'veille', item: subject, result: 'failure', reason: err.message });
        if (err.isQuota) {
          return c.json({
            error: 'Quota Gemini épuisé pour aujourd\'hui. Réessaie demain ou vérifie tes limites dans Paramètres.',
            quota: true,
          }, 429);
        }
        if (err.isAuth) {
          return c.json({ error: 'Clé Gemini invalide ou révoquée.', auth: true }, 401);
        }
        return c.json({ error: err.message }, 500);
      }
    }

    // ── Mode actualité (grounding Google Search) ───────────────────────────────
    const prompt = actualitePrompt(subject);
    let lastErr;

    for (const model of GROUNDING_MODELS) {
      try {
        const result = await completeWithGrounding({ apiKey: keys.gemini_key, model, prompt });
        const warning = result.sources.length === 0
          ? 'Aucune source web récupérée par le grounding — les informations peuvent ne pas être à jour.'
          : null;
        logger?.info({ subject, model, sources: result.sources.length, mode }, 'research actualite done');
        insertActivityLog({ opType: 'veille', item: subject, result: 'success', modelUsed: model });
        return c.json({
          content: result.text,
          model,
          mode,
          sources: result.sources,
          ...(warning ? { warning } : {}),
        });
      } catch (err) {
        lastErr = err;
        if (err.isAuth) {
          return c.json({ error: 'Clé Gemini invalide ou révoquée.', auth: true }, 401);
        }
        // 400 (feature not supported), 404 (model not found), 429 (quota) → try next
        logger?.warn({ model, status: err.message }, 'grounding model failed, trying next');
      }
    }

    // All grounding models failed
    logger?.warn({ subject, err: lastErr?.message }, 'all grounding models failed');
    insertActivityLog({ opType: 'veille', item: subject, result: 'failure', reason: lastErr?.message ?? 'grounding indisponible' });
    return c.json({
      error: 'Le grounding Google Search est indisponible sur ton quota gratuit actuel. ' +
             'Utilise le mode "Synthèse de fond" pour une réponse sans recherche web.',
      grounding_unavailable: true,
    }, 503);
  });

  // ── GET /api/research/quota ───────────────────────────────────────────────────
  app.get('/research/quota', (c) => {
    const used = getGroundingUsage();
    return c.json({
      groundingUsed:      used,
      groundingLimit:     GROUNDING_DAILY_LIMIT,
      groundingRemaining: Math.max(0, GROUNDING_DAILY_LIMIT - used),
    });
  });

  // ── POST /api/research/deep/plan ─────────────────────────────────────────────
  // Decompose a subject into N complementary subtopics.
  app.post('/research/deep/plan', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body    = await c.req.json().catch(() => ({}));
    const subject = String(body.subject ?? '').trim();
    const depth   = Math.min(15, Math.max(2, Number(body.depth) || 5));

    if (!subject) return c.json({ error: 'Sujet manquant' }, 400);
    if (subject.length > 500) return c.json({ error: 'Sujet trop long (max 500 caractères)' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) return c.json({ error: 'Clé Gemini non configurée.', no_key: true }, 503);
    setGeminiRpm((getRouterSettings().gemini_rpm ?? 10));

    const prompt = `Tu es un expert en veille stratégique. Décompose le sujet "${subject}" en exactement ${depth} sous-sujets complémentaires et non redondants, couvrant différents angles (technique, économique, social, historique, prospectif, réglementaire...).

IMPORTANT : Réponds UNIQUEMENT avec une liste numérotée, sans introduction ni conclusion, un sous-sujet par ligne :
1. [sous-sujet 1]
2. [sous-sujet 2]
...

Chaque sous-sujet doit être :
- Complémentaire aux autres (zéro redite)
- Précis et délimité (suffisant pour un article dense de 600-900 mots)
- Ensemble, les ${depth} sous-sujets couvrent le sujet "${subject}" de façon exhaustive`;

    try {
      const result = await completeWithCascade({
        apiKey:    keys.gemini_key,
        messages:  [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        logger,
      });
      const lines = (result.text || '')
        .split('\n')
        .map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(l => l.length > 3)
        .slice(0, depth);

      if (lines.length < 2) {
        return c.json({ error: 'Impossible de décomposer le sujet — réessaie avec un sujet plus précis.' }, 500);
      }
      logger?.info({ subject, depth: lines.length, model: result.model }, 'deep plan done');
      return c.json({ subtopics: lines, model: result.model });
    } catch (err) {
      if (err.isAuth)  return c.json({ error: 'Clé Gemini invalide ou révoquée.', auth: true }, 401);
      if (err.isQuota) return c.json({ error: 'Quota Gemini épuisé pour aujourd\'hui.', quota: true }, 429);
      return c.json({ error: err.message || 'Erreur lors de la décomposition' }, 500);
    }
  });

  // ── POST /api/research/deep/section ──────────────────────────────────────────
  // Generate dense content for one subtopic of a deep research.
  app.post('/research/deep/section', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body        = await c.req.json().catch(() => ({}));
    const subject     = String(body.subject  ?? '').trim();
    const subtopic    = String(body.subtopic ?? '').trim();
    const index       = Math.max(1, Number(body.index) || 1);
    const total       = Math.max(1, Number(body.total) || 1);
    const source      = body.source === 'web' ? 'web' : 'ia';
    const otherTopics = Array.isArray(body.otherTopics)
      ? body.otherTopics.map(String).filter(Boolean).slice(0, 20)
      : [];

    if (!subject || !subtopic) return c.json({ error: 'Sujet et sous-sujet requis' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) return c.json({ error: 'Clé Gemini non configurée.', no_key: true }, 503);
    setGeminiRpm((getRouterSettings().gemini_rpm ?? 10));

    if (source === 'web') {
      const remaining = GROUNDING_DAILY_LIMIT - getGroundingUsage();
      if (remaining <= 0) {
        return c.json({ error: 'Quota de recherche web épuisé (20 requêtes/jour). Utilise le mode "Connaissances IA" pour continuer.', quota: true }, 429);
      }
    }

    const date = new Date().toLocaleDateString('fr-FR');
    const noRepeat = otherTopics.length > 0
      ? `\n\nNOTE : Ce texte fait partie d'une série de ${total} articles sur "${subject}". Les autres articles traitent de : ${otherTopics.join(', ')}. Évite absolument de répéter ce qui est couvert par ces autres angles.`
      : '';

    const prompt = source === 'web'
      ? `Fais une recherche web et rédige un article dense sur ce sous-sujet de la veille "${subject}" :

## ${subtopic}${noRepeat}

IMPÉRATIF : Pour chaque information importante, cite la source avec [Titre](URL).
Rédige 600 à 900 mots structurés avec des sous-sections (###).
Données récentes, exemples concrets, chiffres si disponibles.

Termine par une ligne : *Généré par IA le ${date} — à vérifier via les sources.*`
      : `Tu es un expert en veille stratégique. Rédige un article dense et précis sur ce sous-sujet de la veille "${subject}" :

## ${subtopic}${noRepeat}

Longueur : 600 à 900 mots. Structure avec sous-sections (###). Données chiffrées, exemples concrets, analyses.
Zéro remplissage — chaque phrase doit apporter une information.

Termine par : *Synthèse basée sur les connaissances de l'IA — à vérifier pour les données récentes.*`;

    try {
      let text, model, sources = [];

      if (source === 'web') {
        let done = false;
        let lastErr;
        for (const gModel of GROUNDING_MODELS) {
          try {
            const r = await completeWithGrounding({ apiKey: keys.gemini_key, model: gModel, prompt });
            text = r.text; model = gModel; sources = r.sources ?? [];
            incrementGroundingUsage();
            done = true;
            break;
          } catch (err) {
            lastErr = err;
            if (err.isAuth) throw err;
          }
        }
        if (!done) {
          return c.json({ error: 'Grounding web indisponible sur ce quota. Essaie le mode "Connaissances IA".', grounding_unavailable: true }, 503);
        }
      } else {
        const r = await completeWithCascade({ apiKey: keys.gemini_key, messages: [{ role: 'user', content: prompt }], maxTokens: 4096, logger });
        text = r.text; model = r.model;
      }

      logger?.info({ subject, subtopic, index, total, source, model }, 'deep section done');
      return c.json({ content: text, model, sources });
    } catch (err) {
      if (err.isAuth)  return c.json({ error: 'Clé Gemini invalide.', auth: true }, 401);
      if (err.isQuota) return c.json({ error: 'Quota Gemini épuisé.', quota: true }, 429);
      return c.json({ error: err.message || 'Erreur lors de la génération' }, 500);
    }
  });

  // ── POST /api/research/deep/document ─────────────────────────────────────────
  // Generate a single long structured document.
  app.post('/research/deep/document', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body    = await c.req.json().catch(() => ({}));
    const subject = String(body.subject ?? '').trim();
    const depth   = Math.min(15, Math.max(2, Number(body.depth) || 5));
    const source  = body.source === 'web' ? 'web' : 'ia';

    if (!subject) return c.json({ error: 'Sujet manquant' }, 400);
    if (subject.length > 500) return c.json({ error: 'Sujet trop long' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) return c.json({ error: 'Clé Gemini non configurée.', no_key: true }, 503);
    setGeminiRpm((getRouterSettings().gemini_rpm ?? 10));

    if (source === 'web') {
      const remaining = GROUNDING_DAILY_LIMIT - getGroundingUsage();
      if (remaining <= 0) {
        return c.json({ error: 'Quota de recherche web épuisé (20/jour). Utilise le mode "Connaissances IA".', quota: true }, 429);
      }
    }

    const sections = depth <= 5 ? '5 à 7' : depth <= 10 ? '8 à 12' : '12 à 15';
    const date     = new Date().toLocaleDateString('fr-FR');

    const prompt = source === 'web'
      ? `Fais une recherche web approfondie et rédige un document de synthèse complet sur : **${subject}**

Structure : ${sections} sections principales avec sous-sections.
IMPÉRATIF : Pour chaque affirmation, cite la source avec [Titre](URL).
Format : ## pour les sections, ### pour les sous-sections, listes à puces pour les points clés.
Minimum 1500 mots. Commence par ## Résumé exécutif. Termine par ## Sources.

Dernière ligne : *Document généré par IA le ${date} — à vérifier via les sources.*`
      : `Tu es un expert en veille stratégique. Rédige un document de synthèse complet et détaillé sur : **${subject}**

Structure : ${sections} sections principales avec sous-sections.
Format : ## pour les sections, ### pour les sous-sections, listes à puces.
Minimum 1500 mots. Dense, précis, zéro remplissage. Données chiffrées et exemples concrets.
Commence par ## Résumé exécutif. Couvre : contexte, aspects techniques, économiques/sociaux, acteurs, tendances, perspectives.

Dernière ligne : *Synthèse basée sur les connaissances de l'IA (${date}) — à vérifier pour les données récentes.*`;

    try {
      let text, model, sources = [];

      if (source === 'web') {
        let done = false;
        for (const gModel of GROUNDING_MODELS) {
          try {
            const r = await completeWithGrounding({ apiKey: keys.gemini_key, model: gModel, prompt });
            text = r.text; model = gModel; sources = r.sources ?? [];
            incrementGroundingUsage();
            done = true;
            break;
          } catch (err) {
            if (err.isAuth) throw err;
          }
        }
        if (!done) return c.json({ error: 'Grounding web indisponible.', grounding_unavailable: true }, 503);
      } else {
        const r = await completeWithCascade({ apiKey: keys.gemini_key, messages: [{ role: 'user', content: prompt }], maxTokens: 8192, logger });
        text = r.text; model = r.model;
      }

      logger?.info({ subject, depth, source, model }, 'deep document done');
      return c.json({ content: text, model, sources });
    } catch (err) {
      if (err.isAuth)  return c.json({ error: 'Clé Gemini invalide.', auth: true }, 401);
      if (err.isQuota) return c.json({ error: 'Quota Gemini épuisé.', quota: true }, 429);
      return c.json({ error: err.message || 'Erreur lors de la génération' }, 500);
    }
  });

  // ── POST /api/research/review ─────────────────────────────────────────────────
  // Sends neurone content to gemini-3.1-flash-lite for critical review.
  // Falls back to local Ollama so the user always gets something.
  app.post('/research/review', async (c) => {
    const body    = await c.req.json().catch(() => ({}));
    const content = String(body.content ?? '').trim();

    if (!content) return c.json({ error: 'Contenu manquant' }, 400);
    if (content.length > 50_000) return c.json({ error: 'Contenu trop long (max 50 000 caractères)' }, 400);

    const messages = [
      {
        role:    'system',
        content: 'Tu es un assistant d\'analyse critique. Sois honnête et rigoureux dans ton évaluation.',
      },
      { role: 'user', content: reviewPrompt(content) },
    ];

    // Mode local strict → sauter Gemini, aller directement au fallback local
    if (getRouterSettings()?.strict_local_mode === true) {
      if (fallbackChat) {
        try {
          const text = await fallbackChat(messages);
          return c.json({ review: text, model: 'local', strict_local: true });
        } catch (err) {
          return c.json({ error: `Relecture locale impossible : ${err.message}` }, 503);
        }
      }
      return c.json(STRICT_LOCAL_ERROR, 503);
    }

    const keys = getCloudKeys();

    // Prefer gemini-3.1-flash-lite (500 RPD) — leaves 2.5 quota for actual research
    if (keys.gemini_key) {
      try {
        const result = await complete({ apiKey: keys.gemini_key, model: DEFAULT_MODEL, messages, maxTokens: 4096 });
        logger?.info({ model: DEFAULT_MODEL }, 'research review done via gemini');
        return c.json({ review: result.text, model: DEFAULT_MODEL });
      } catch (err) {
        if (err.isAuth) {
          return c.json({ error: 'Clé Gemini invalide ou révoquée.', auth: true }, 401);
        }
        logger?.warn({ err: err.message }, 'gemini review failed, falling back to local');
      }
    }

    // Fallback: local Ollama (relecture locale vaut mieux qu'un échec total)
    if (fallbackChat) {
      try {
        const text = await fallbackChat(messages);
        logger?.info({ model: 'local' }, 'research review done via local fallback');
        return c.json({ review: text, model: 'local' });
      } catch (err) {
        logger?.error({ err: err.message }, 'research review local fallback also failed');
      }
    }

    return c.json({ error: 'Relecture impossible : Gemini et le modèle local sont indisponibles.' }, 503);
  });

  // ── POST /api/research/multi/plan ────────────────────────────────────────────
  // Decompose a subject into N distinct angles for multi-source cross-checking.
  // Uses cascade (no grounding) — 1 cloud call, no quota consumed.
  app.post('/research/multi/plan', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body    = await c.req.json().catch(() => ({}));
    const subject = String(body.subject ?? '').trim();
    const angles  = Math.min(5, Math.max(3, Number(body.angles) || 4));

    if (!subject) return c.json({ error: 'Sujet manquant' }, 400);
    if (subject.length > 500) return c.json({ error: 'Sujet trop long (max 500 caractères)' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) return c.json({ error: 'Clé Gemini non configurée.', no_key: true }, 503);
    setGeminiRpm((getRouterSettings().gemini_rpm ?? 10));

    const prompt = `Tu es un expert en veille stratégique. Décompose le sujet "${subject}" en exactement ${angles} ANGLES D'ANALYSE distincts et complémentaires, choisis pour maximiser la diversité des sources et permettre un recoupement d'informations.

Les angles doivent couvrir des perspectives différentes : technique, économique, social, politique, historique, prospectif, critique, réglementaire, acteurs/entreprises, etc.

IMPORTANT : Réponds UNIQUEMENT avec une liste numérotée, sans introduction ni conclusion :
1. [angle 1 — formulation courte et précise, max 10 mots]
2. [angle 2]
...

Chaque angle doit être suffisamment distinct pour générer des sources DIFFÉRENTES lors d'une recherche web.`;

    try {
      const result = await completeWithCascade({ apiKey: keys.gemini_key, messages: [{ role: 'user', content: prompt }], maxTokens: 512, logger });
      const angles_list = (result.text || '')
        .split('\n')
        .map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(l => l.length > 3)
        .slice(0, 5);

      if (angles_list.length < 2) return c.json({ error: 'Impossible de décomposer le sujet en angles.' }, 500);
      logger?.info({ subject, count: angles_list.length }, 'multi plan done');
      return c.json({ angles: angles_list, model: result.model });
    } catch (err) {
      if (err.isAuth)  return c.json({ error: 'Clé Gemini invalide.', auth: true }, 401);
      if (err.isQuota) return c.json({ error: 'Quota Gemini épuisé.', quota: true }, 429);
      return c.json({ error: err.message || 'Erreur décomposition' }, 500);
    }
  });

  // ── POST /api/research/multi/source ──────────────────────────────────────────
  // Research one angle with grounding (1 grounding call per angle).
  app.post('/research/multi/source', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body    = await c.req.json().catch(() => ({}));
    const subject = String(body.subject ?? '').trim();
    const angle   = String(body.angle   ?? '').trim();

    if (!subject || !angle) return c.json({ error: 'Sujet et angle requis' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) return c.json({ error: 'Clé Gemini non configurée.', no_key: true }, 503);
    setGeminiRpm((getRouterSettings().gemini_rpm ?? 10));

    const remaining = GROUNDING_DAILY_LIMIT - getGroundingUsage();
    if (remaining <= 0) {
      return c.json({ error: 'Quota de recherche web épuisé (20/jour). Réessaie demain.', quota: true }, 429);
    }

    const date   = new Date().toLocaleDateString('fr-FR');
    const prompt = `Fais une recherche web et rédige une analyse factuelle sur cet angle de la veille "${subject}" :

**Angle : ${angle}**

EXIGENCES STRICTES :
- Pour chaque affirmation ou fait important, cite OBLIGATOIREMENT la source avec [Titre de la source](URL)
- Ne mentionne que des faits vérifiables avec une source web identifiable
- Si tu n'as pas de source pour un point, ne l'inclus pas
- Longueur : 400-600 mots
- Structure : 2-3 sous-sections claires

Termine par :
**Sources citées :**
- [Titre 1](URL1)
- [Titre 2](URL2)
...

*Recherche web du ${date}*`;

    for (const model of GROUNDING_MODELS) {
      try {
        const result = await completeWithGrounding({ apiKey: keys.gemini_key, model, prompt });
        incrementGroundingUsage();
        logger?.info({ subject, angle, model, sources: result.sources.length }, 'multi source done');
        return c.json({ content: result.text, model, sources: result.sources ?? [], angle });
      } catch (err) {
        if (err.isAuth) return c.json({ error: 'Clé Gemini invalide.', auth: true }, 401);
      }
    }
    return c.json({ error: 'Grounding web indisponible sur ce quota. Réessaie ultérieurement.', grounding_unavailable: true }, 503);
  });

  // ── POST /api/research/multi/crosscheck ───────────────────────────────────────
  // Synthesize N source results and produce a cross-checked analysis.
  // Uses cascade (no grounding) — 1 cloud call, no grounding quota consumed.
  app.post('/research/multi/crosscheck', async (c) => {
    if (getRouterSettings()?.strict_local_mode === true) return c.json(STRICT_LOCAL_ERROR, 503);

    const body    = await c.req.json().catch(() => ({}));
    const subject = String(body.subject ?? '').trim();
    const sources = Array.isArray(body.sources) ? body.sources : [];

    if (!subject || sources.length < 2) return c.json({ error: 'Sujet et au moins 2 sources requis' }, 400);

    const keys = getCloudKeys();
    if (!keys.gemini_key) return c.json({ error: 'Clé Gemini non configurée.', no_key: true }, 503);
    setGeminiRpm((getRouterSettings().gemini_rpm ?? 10));

    const sourcesText = sources.map((s, i) =>
      `\n--- SOURCE ${i + 1} : ${s.angle} ---\n${String(s.content ?? '').slice(0, 3000)}`,
    ).join('\n');

    const prompt = `Tu dois RECOUPER et COMPARER les informations issues de ${sources.length} recherches web distinctes sur le sujet : "${subject}".

${sourcesText}

---

Produis une synthèse critique structurée EXACTEMENT en 4 sections :

## 📌 Points de convergence
Identifie les affirmations confirmées ou cohérentes dans PLUSIEURS sources. Pour chaque point, précise "(Sources : [liste des angles confirmant)". N'invente pas de convergence si elle n'existe pas.

## ⚡ Points de divergence
Identifie les contradictions, nuances importantes ou chiffres qui diffèrent entre sources. Explique clairement la divergence et cite les sources concernées.

## ⚠️ Source unique
Liste les affirmations importantes qui n'apparaissent que dans UNE SEULE source. Indique laquelle. Ne pas commenter, juste lister avec la source.

## 🔍 Zones d'ombre
Ce qu'aucune des ${sources.length} sources ne couvre de façon satisfaisante. Angles non explorés, questions ouvertes.

---
RÈGLES ABSOLUES :
- Ne construis jamais de faux consensus : si une info vient d'une seule source, dis-le dans "Source unique"
- Chaque affirmation doit être rattachée à son/ses angle(s) source
- Sois honnête sur les limites : si les sources sont redondantes, dis-le`;

    try {
      const result = await completeWithCascade({ apiKey: keys.gemini_key, messages: [{ role: 'user', content: prompt }], maxTokens: 4096, logger });
      logger?.info({ subject, sourceCount: sources.length }, 'multi crosscheck done');
      return c.json({ synthesis: result.text, model: result.model });
    } catch (err) {
      if (err.isAuth)  return c.json({ error: 'Clé Gemini invalide.', auth: true }, 401);
      if (err.isQuota) return c.json({ error: 'Quota Gemini épuisé.', quota: true }, 429);
      return c.json({ error: err.message || 'Erreur recoupement' }, 500);
    }
  });

  return app;
}
