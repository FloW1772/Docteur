/**
 * Business/Sales Agent — outreach/CRM-note DRAFT composition.
 *
 * V1 is template-based and fully local/deterministic — no LLM call is
 * required to produce a draft. This keeps the highest-risk artifact (text
 * a human might eventually choose to send) free of any cloud dependency
 * and free of any risk that fetched web content could steer generation
 * (research text is never interpolated as instructions here, only as
 * plain, escaped reference fields).
 *
 * Every draft produced by this module MUST be labeled via
 * sales-policy.js's `labelDraft()` before being returned/stored — this
 * module never sends, queues, or writes a draft anywhere outside the
 * return value.
 */

import { labelDraft } from './sales-policy.js';

function sanitizeField(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  // Strip newlines/control chars from anything interpolated into a
  // single-line template field — research text is DATA, never formatting
  // instructions, so it cannot inject extra lines into the draft.
  return value.replace(/[\r\n\x00-\x1F]/g, ' ').trim().slice(0, maxLength);
}

/**
 * @param {object} lead - { name, company }
 * @param {object} score - result of scoreLead() (optional, for context lines only)
 * @param {string} tone - 'neutral' | 'formal' | 'concise' — V1 supports a fixed small set, no free-text tone injection
 */
const ALLOWED_TONES = new Set(['neutral', 'formal', 'concise']);

export function draftOutreachMessage({ lead, score, tone = 'neutral' }) {
  const name = sanitizeField(lead?.name);
  const company = sanitizeField(lead?.company);
  const safeTone = ALLOWED_TONES.has(tone) ? tone : 'neutral';
  if (!name) throw new Error('lead_name_required_for_draft');

  const matchedLabels = Array.isArray(score?.matched) ? score.matched.map((m) => sanitizeField(m.label, 80)) : [];
  const contextLine = matchedLabels.length > 0
    ? `Points de correspondance identifiés (recherche automatisée, à vérifier) : ${matchedLabels.join(', ')}.`
    : 'Aucun point de correspondance déterministe trouvé dans les sources recherchées — contexte à compléter manuellement.';

  const greeting = safeTone === 'formal' ? `Bonjour${name ? ` ${name}` : ''},` : `Bonjour ${name},`;
  const closing = safeTone === 'concise'
    ? 'Disponible pour en discuter si pertinent.'
    : 'Je serais ravi d\'échanger quelques minutes si cela vous semble pertinent.';

  const body = [
    greeting,
    '',
    `Je me permets de vous contacter${company ? ` au sujet de ${company}` : ''}.`,
    contextLine,
    '',
    closing,
    '',
    '[SIGNATURE À COMPLÉTER PAR L\'UTILISATEUR]',
  ].join('\n');

  return labelDraft({
    kind: 'outreach_message',
    leadName: name,
    company,
    tone: safeTone,
    subject: `Prise de contact${company ? ` — ${company}` : ''}`,
    body,
    generatedAt: new Date().toISOString(),
    disclaimer: 'Brouillon généré automatiquement à partir de recherches non vérifiées. Relire et personnaliser avant tout envoi. Docteur n\'envoie jamais ce message automatiquement.',
  });
}

/**
 * A CRM-style note draft — text only, never written to any real CRM.
 */
export function draftCrmNote({ lead, score, sources }) {
  const name = sanitizeField(lead?.name);
  const company = sanitizeField(lead?.company);
  if (!name) throw new Error('lead_name_required_for_draft');

  const sourceCount = Array.isArray(sources) ? sources.length : 0;
  const scoreLine = typeof score?.score === 'number'
    ? `Score de correspondance (déterministe, sur critères définis par l'utilisateur) : ${score.score}/100.`
    : 'Score non calculable — données de recherche insuffisantes.';

  const note = [
    `Lead : ${name}${company ? ` (${company})` : ''}`,
    scoreLine,
    `Sources de recherche consultées : ${sourceCount} (toutes marquées non fiables / à vérifier).`,
    'Aucune action externe effectuée automatiquement (pas d\'email envoyé, pas d\'écriture CRM réelle, pas de formulaire soumis).',
  ].join('\n');

  return labelDraft({
    kind: 'crm_note',
    leadName: name,
    company,
    note,
    generatedAt: new Date().toISOString(),
    disclaimer: 'Note générée automatiquement — brouillon local uniquement, jamais écrite dans un CRM réel.',
  });
}
