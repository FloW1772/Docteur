// Niveau de détail (registre) pour les fonctionnalités de veille/recherche.
// Un seul point de vérité pour les instructions de prompt par niveau,
// partagé entre routes/research.js et lib/agent-runner.js.

export const DETAIL_LEVELS = ['synthese', 'standard', 'pedagogique', 'expert'];

export const DETAIL_LEVEL_LABELS = {
  synthese:    'Synthèse',
  standard:    'Standard',
  pedagogique: 'Pédagogique',
  expert:      'Expert',
};

export function normalizeDetailLevel(value) {
  return DETAIL_LEVELS.includes(value) ? value : 'synthese';
}

// Consigne commune à tous les niveaux : jamais inventer, signaler l'incertain,
// citer les sources quand une recherche web a été utilisée.
const HONESTY_CLAUSE = `Règles impératives : n'invente jamais d'information ; signale explicitement ce qui est incertain, daté ou non vérifié ; si une recherche web a été utilisée, cite les sources.`;

// Retourne le bloc d'instruction (français) à insérer dans le prompt système
// pour un niveau donné. 'synthese' reste un no-op de contenu (comportement
// actuel inchangé) mais porte quand même la clause d'honnêteté commune.
export function detailLevelInstruction(level) {
  const lvl = normalizeDetailLevel(level);

  switch (lvl) {
    case 'standard':
      return `Niveau de détail demandé : STANDARD. Explique les notions progressivement, définis les termes techniques dès leur première apparition, donne du contexte suffisant pour quelqu'un qui découvre le sujet. ${HONESTY_CLAUSE}`;

    case 'pedagogique':
      return `Niveau de détail demandé : PÉDAGOGIQUE. Explique comme à quelqu'un qui part de zéro : utilise des analogies et des exemples concrets du quotidien, définis CHAQUE terme technique dès sa première apparition, progresse du plus simple vers le plus complexe. Le texte peut être plus long — l'accessibilité prime sur la densité. ${HONESTY_CLAUSE}`;

    case 'expert':
      return `Niveau de détail demandé : EXPERT. Suppose les bases acquises, ne perds pas de temps à expliquer l'évident, va aux détails techniques, aux nuances, et signale les points qui font débat dans le domaine. ${HONESTY_CLAUSE}`;

    case 'synthese':
    default:
      return HONESTY_CLAUSE;
  }
}
