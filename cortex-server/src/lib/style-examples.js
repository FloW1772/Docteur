// Exemples de style utilisateur — sélection et mise en forme partagées entre
// tous les points de résumé de l'app (capture profonde, veille, résumé de
// vidéo longue). Extrait et généralisé depuis video-pipeline/pipeline.js.
//
// Mécanisme : recherche sémantique existante (services.searchNeurons) filtrée
// sur le kind 'exemple-resume'. Quand un type explicite est fourni (autre que
// 'auto'), on récupère un plus large lot puis on booste/reclasse les exemples
// dont metadata.type correspond, avant de retomber sur le classement sémantique
// pur pour compléter jusqu'à la limite demandée.

const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.15;

export async function findStyleExamples(services, { type, queryText, limit = DEFAULT_LIMIT } = {}) {
  if (!services?.searchNeurons) return [];
  try {
    const hasType = type && type !== 'auto';
    const query = hasType
      ? `résumé de type ${type} : ${queryText ?? ''}`
      : (queryText ?? 'résumé');

    const searchLimit = hasType ? Math.max(limit * 4, 20) : limit;
    const result = await services.searchNeurons({
      query, limit: searchLimit, threshold: DEFAULT_THRESHOLD, filter_by_kind: ['exemple-resume'],
    });
    // Never use private neurons (cv, candidature, user-marked private) as style
    // examples — this prompt can be sent to a cloud model, so private content
    // must be excluded at the source, not just relied on the provider guard.
    const candidates = (result?.results ?? []).filter(e => e.private !== true);
    if (candidates.length === 0) return [];

    if (!hasType) return candidates.slice(0, limit);

    const matching = candidates.filter(e => e.metadata?.type === type);
    const rest = candidates.filter(e => e.metadata?.type !== type);
    return [...matching, ...rest].slice(0, limit);
  } catch { return []; }
}

export function buildStyleExamplesBlock(examples) {
  if (!examples || examples.length === 0) return '';
  return `\n\nVoici ${examples.length} exemple(s) de résumés de référence, dans le style que tu dois reproduire (STRUCTURE, TON, NIVEAU DE DÉTAIL, MANIÈRE DE PRIORISER L'INFORMATION et MISE EN FORME uniquement — ne recopie jamais leurs mots ou leur contenu, ils portent sur un autre sujet, et n'invente jamais d'information absente de la source à résumer) :\n\n${examples.map((e, i) => `--- Exemple ${i + 1} (${e.title}) ---\n${e.content_preview}`).join('\n\n')}`;
}

export function describeUsedExamples(examples) {
  if (!examples || examples.length === 0) return [];
  return examples.map(e => ({ id: e.id, title: e.title, type: e.metadata?.type ?? null }));
}
