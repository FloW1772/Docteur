import { getRouterSettings, getCloudKeys } from './sqlite.js';
import { getModelStatuses } from './router.js';

// ── Available models — local (installed) + cloud (key configured), gated by strict_local_mode ─

export async function listAvailableModels(installedNames) {
  const settings = getRouterSettings();
  const keys     = getCloudKeys();

  const local = getModelStatuses(installedNames)
    .filter(s => s.installed)
    .map(s => ({ id: s.model, provider: 'local', label: s.model, level_label: s.level_label }));

  const cloud = [];
  if (!settings.strict_local_mode) {
    if (keys.gemini_key) {
      cloud.push({ id: 'gemini', provider: 'gemini', label: 'Gemini (cloud)' });
    }
    if (keys.groq_key) {
      cloud.push({ id: settings.groq_model ?? 'openai/gpt-oss-120b', provider: 'groq', label: 'Groq (cloud)' });
    }
  }

  return { local, cloud, strict_local_mode: !!settings.strict_local_mode };
}

// ── Model-agnostic dispatcher — wraps existing provider modules, no duplication ─

// ── Stage 1 — draft ──────────────────────────────────────────────────────────

const DRAFT_SYSTEM_PROMPT = `Tu es un expert en rédaction de prompts techniques pour agents de développement autonomes.
À partir d'une demande utilisateur, rédige un PROMPT STRUCTURÉ, en français, au style cahier des charges technique.

Le prompt doit obligatoirement contenir :
- Une section CONTEXTE qui explique le cadre et l'objectif.
- Des sections numérotées claires pour chaque tâche ou exigence.
- Des consignes explicites de type "autonome, sans questions", "npx tsc --noEmit propre" (si le contexte est du code), "Recap + tests" en fin de mission.
- Une section VALIDATION numérotée listant les critères de réussite vérifiables.

Réponds UNIQUEMENT avec le texte du prompt structuré, sans préambule ni commentaire meta.`;

export function buildDraftMessages(request) {
  return [
    { role: 'system', content: DRAFT_SYSTEM_PROMPT },
    { role: 'user', content: `Demande : ${request}` },
  ];
}

// ── Stage 2 — review ─────────────────────────────────────────────────────────

const REVIEW_DELIMITER = '---CHANGEMENTS---';
const NO_CHANGE_MARKER = 'AUCUN CHANGEMENT';

const REVIEW_SYSTEM_PROMPT = `Tu es un relecteur expert de prompts techniques pour agents de développement autonomes.
On te fournit un prompt déjà rédigé. Ton rôle : vérifier — pas réinventer.

Cherche uniquement :
- des ambiguïtés,
- des contradictions,
- des critères de validation manquants ou peu vérifiables,
- des garde-fous manquants (sécurité, portée, destructivité),
- des consignes vagues.

Règles strictes :
- N'invente AUCUNE nouvelle exigence qui ne découle pas du prompt original.
- Si le prompt est déjà bon, ne change RIEN — c'est une réponse valide et même souhaitable.
- Réponds TOUJOURS avec exactement ce format, dans cet ordre :

Le texte du prompt (identique à l'original si aucun changement, sinon la version corrigée en entier)

${REVIEW_DELIMITER}

Si aucun changement n'était nécessaire, écris exactement "${NO_CHANGE_MARKER}" suivi d'une brève justification.
Sinon, liste précisément CE QUI a changé et POURQUOI, point par point.`;

export function buildReviewMessages(draftPrompt) {
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `Prompt à relire :\n\n${draftPrompt}` },
  ];
}

export function parseReviewOutput(rawText, originalDraft) {
  const idx = rawText.indexOf(REVIEW_DELIMITER);
  if (idx === -1) {
    // Model didn't respect the delimiter — treat whole output as the reviewed text
    return { reviewedText: rawText.trim(), changesExplained: '', unchanged: false };
  }

  const reviewedText = rawText.slice(0, idx).trim();
  const explanation  = rawText.slice(idx + REVIEW_DELIMITER.length).trim();
  const unchanged    = explanation.toUpperCase().includes(NO_CHANGE_MARKER);

  return {
    reviewedText: reviewedText || originalDraft,
    changesExplained: explanation,
    unchanged,
  };
}
