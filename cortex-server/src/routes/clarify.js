import { Hono } from 'hono';
import { getCloudKeys, getRouterSettings } from '../lib/sqlite.js';
import { tryCloudFallbackChain } from '../lib/router.js';

const CLARIFY_SYSTEM = `Tu es un assistant intelligent. Tu analyses des demandes pour déterminer si elles nécessitent des précisions personnelles AVANT de pouvoir y répondre utilement.

DÉCLENCHE la clarification uniquement quand la demande :
- Demande un plan, une stratégie ou un accompagnement personnalisé ("aide-moi à", "fais-moi un plan", "comment je peux")
- Dépend explicitement du budget, du temps disponible, des compétences ou de la situation personnelle
- Est trop vague pour donner une réponse utile sans hypothèses sur la situation personnelle
- Comporte des objectifs chiffrés ou temporels flous sans contexte ("en 3 mois", "rapidement", "me lancer")

NE DÉCLENCHE PAS pour :
- Questions factuelles ("qu'est-ce que X ?", "comment fonctionne Y ?")
- Questions sur les neurones/notes de l'utilisateur ("résume mes articles sur X", "qu'est-ce que j'ai noté sur Y")
- Recherches d'informations générales
- Commandes (veille, lis, ouvre, recherche)
- Toute question où une bonne réponse générale est possible

EN CAS DE DOUTE : réponds needs_clarification: false. Vaut mieux répondre directement que poser des questions inutiles.

Si tu déclenches, génère 3 à 5 questions PERTINENTES et SPÉCIFIQUES à CETTE demande particulière (jamais génériques), avec 3-4 réponses prédéfinies adaptées au contexte.

Réponds UNIQUEMENT en JSON valide (sans markdown, sans blocs de code) :
{"needs_clarification":false}
ou
{"needs_clarification":true,"questions":[{"id":"q1","text":"La question précise ?","choices":["Option A","Option B","Option C"]}]}`;

function parseJsonSafe(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```(?:json)?\n?/g, '').replace(/```\n?/g, '').trim();
  // Extract first {...} block in case of trailing text (non-greedy to avoid
  // catastrophic backtracking on malformed/very long LLM output).
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

export function createClarifyRoute({ logger } = {}) {
  const route = new Hono();

  route.post('/clarify', async (c) => {
    const body     = await c.req.json().catch(() => null);
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) return c.json({ error: 'question requise' }, 400);

    const keys     = getCloudKeys();
    const settings = getRouterSettings();

    // Mode local strict → pas de clarification cloud
    if (settings?.strict_local_mode === true) {
      return c.json({ needs_clarification: false, cloud_unavailable: true });
    }

    const hasCloud = !!(keys.gemini_key || keys.groq_key || keys.openrouter_key ||
      (settings?.paying_apis_enabled && (keys.anthropic_key || keys.openai_key)));

    if (!hasCloud) {
      return c.json({ needs_clarification: false, cloud_unavailable: true });
    }

    const messages = [
      { role: 'system', content: CLARIFY_SYSTEM },
      { role: 'user',   content: question },
    ];

    const result = await tryCloudFallbackChain(messages, { logger }).catch(err => {
      if (logger) logger.warn({ error: err.message }, 'CLARIFY: all cloud providers failed');
      return null;
    });

    if (!result) {
      return c.json({ needs_clarification: false, cloud_unavailable: true });
    }

    const parsed = parseJsonSafe(result.text);
    if (!parsed || typeof parsed.needs_clarification !== 'boolean') {
      if (logger) logger.warn({ text: result.text.slice(0, 200) }, 'CLARIFY: invalid JSON from LLM');
      return c.json({ needs_clarification: false });
    }

    if (logger) {
      logger.info({
        question: question.slice(0, 60),
        needs:    parsed.needs_clarification,
        count:    parsed.questions?.length ?? 0,
        provider: result.provider,
      }, 'CLARIFY_DONE');
    }

    return c.json({
      needs_clarification: parsed.needs_clarification,
      questions:           parsed.needs_clarification ? (parsed.questions ?? []) : [],
      provider:            result.provider,
    });
  });

  return route;
}
