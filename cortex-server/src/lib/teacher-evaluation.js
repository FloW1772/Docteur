// Professeur V2 (PROF-2) — structured, bounded evaluation verdicts. Replaces, for V2 parcours ONLY, the historical
// "does the free text contain VALIDÉ?" rule (which also matched "non VALIDÉ"). V1 parcours keep their behaviour.
//
// Contract (anything else is rejected — FAIL CLOSED, never "passed by default"):
//   { passed: boolean, score: integer 0..100, criteria: [{ name: string, met: boolean, comment?: string }] (0..10),
//     feedback: string }
// Consistency rules: passed === true requires score >= PASS_THRESHOLD and no criterion with met === false.
// An inconsistent verdict (e.g. passed:true, score:12) is downgraded to a failure, never upgraded.

export const PASS_THRESHOLD = 60;
export const MAX_CRITERIA = 10;
const MAX_NAME = 160;
const MAX_COMMENT = 600;
const MAX_FEEDBACK = 4000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @returns {{ ok: true, verdict: { passed, score, criteria, feedback, inconsistent?: true } } | { ok: false, reason: string }}
 */
export function validateVerdict(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not_an_object' };
  if (typeof raw.passed !== 'boolean') return { ok: false, reason: 'passed_not_boolean' };
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100) return { ok: false, reason: 'score_out_of_range' };
  if (raw.criteria !== undefined && !Array.isArray(raw.criteria)) return { ok: false, reason: 'criteria_not_array' };
  const criteriaIn = raw.criteria ?? [];
  if (criteriaIn.length > MAX_CRITERIA) return { ok: false, reason: 'too_many_criteria' };
  const criteria = [];
  for (const c of criteriaIn) {
    if (!isPlainObject(c) || typeof c.name !== 'string' || !c.name.trim() || typeof c.met !== 'boolean') return { ok: false, reason: 'criterion_invalid' };
    if (c.comment !== undefined && typeof c.comment !== 'string') return { ok: false, reason: 'criterion_invalid' };
    criteria.push({ name: c.name.trim().slice(0, MAX_NAME), met: c.met, ...(c.comment ? { comment: c.comment.slice(0, MAX_COMMENT) } : {}) });
  }
  if (raw.feedback !== undefined && typeof raw.feedback !== 'string') return { ok: false, reason: 'feedback_not_string' };
  const score = Math.round(raw.score);
  const consistent = !raw.passed || (score >= PASS_THRESHOLD && criteria.every(c => c.met));
  return {
    ok: true,
    verdict: {
      passed: raw.passed && consistent,
      score,
      criteria,
      feedback: String(raw.feedback ?? '').slice(0, MAX_FEEDBACK),
      ...(consistent ? {} : { inconsistent: true }),
    },
  };
}

/** The verdict recorded when the model output cannot be trusted: NOT passed, and flagged as not a learner failure. */
export function invalidEvaluationVerdict(reason) {
  return { passed: false, score: 0, criteria: [], feedback: 'L’évaluation automatique n’a pas produit de verdict exploitable — réessaie.', invalid: true, reason: String(reason).slice(0, 80) };
}

const VERDICT_FORMAT = `Réponds UNIQUEMENT avec un JSON valide, sans texte autour ni balises : {"passed": true|false, "score": <entier 0-100>, "criteria": [{"name": "<critère>", "met": true|false, "comment": "<court>"}], "feedback": "<retour pédagogique en français>"}. "passed" n'est true que si la réponse démontre une compréhension suffisante (score >= ${PASS_THRESHOLD} et tous les critères remplis). Si "passed" est false, ajoute "remediation": {"focus": "<la notion précise à retravailler>", "why": "<ce qui est incorrect et pourquoi>", "retry": "<une nouvelle consigne courte et ciblée pour réessayer>"}, rédigé dans le même registre pédagogique.`;

export function buildTheoryEvaluationPrompt({ subject, registerInstruction, stepTitle, question, userAnswer }) {
  return [
    { role: 'system', content: `Tu es un professeur qui évalue la partie THÉORIE de l'étape "${stepTitle}" du sujet "${subject}". ${registerInstruction}\n\nÉvalue avec des critères explicites (2 à 5). ${VERDICT_FORMAT}` },
    ...(question ? [{ role: 'system', content: `Question posée : ${question}` }] : []),
    { role: 'user', content: `Réponse de l'apprenant : "${userAnswer}"` },
  ];
}

export function buildPracticeAssessmentPrompt({ subject, registerInstruction, stepTitle, spec, submission }) {
  const rubric = (spec?.rubric ?? []).length ? `\nGrille d'évaluation : ${(spec.rubric).map((r, i) => `${i + 1}. ${r}`).join(' ; ')}` : '';
  return [
    { role: 'system', content: `Tu es un professeur qui évalue la partie PRATIQUE de l'étape "${stepTitle}" du sujet "${subject}". ${registerInstruction}\n\nConsigne de l'exercice : ${spec?.instructions ?? ''}${rubric}\n\nTu n'évalues QUE le livrable fourni ci-dessous ; tu ne peux pas observer d'action réelle au-delà de ce texte. ${VERDICT_FORMAT}` },
    { role: 'user', content: `Livrable de l'apprenant :\n${submission}` },
  ];
}

/** SELF_REPORTED: the learner confirms the server-side checklist items. Passed only if EVERY item is confirmed. */
export function selfReportVerdict(spec, confirmations) {
  const items = Array.isArray(spec?.checklist) ? spec.checklist : [];
  if (items.length === 0) return { ok: false, reason: 'no_checklist' };
  if (!Array.isArray(confirmations) || confirmations.length !== items.length || confirmations.some(v => typeof v !== 'boolean')) {
    return { ok: false, reason: 'confirmations_mismatch' };
  }
  const criteria = items.map((name, i) => ({ name: String(name).slice(0, MAX_NAME), met: confirmations[i] }));
  const met = criteria.filter(c => c.met).length;
  return {
    ok: true,
    verdict: {
      passed: met === items.length,
      score: Math.round((met / items.length) * 100),
      criteria,
      feedback: met === items.length
        ? 'Réalisation déclarée par l’apprenant (non observée par Docteur).'
        : 'Tous les points de la checklist ne sont pas encore réalisés.',
      selfReported: true,
    },
  };
}

const normalize = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * VERIFIED: only when the spec carries a server-stored expected result and the submission matches it deterministically.
 * Returns null when no deterministic check exists (the caller must then use MODEL_ASSESSED or SELF_REPORTED).
 */
export function deterministicPracticeCheck(spec, submission) {
  if (spec?.kind !== 'result' || typeof spec.expected !== 'string' || !spec.expected.trim()) return null;
  const passed = normalize(submission) === normalize(spec.expected);
  return {
    passed,
    score: passed ? 100 : 0,
    criteria: [{ name: 'Résultat attendu', met: passed }],
    feedback: passed ? 'Résultat vérifié par Docteur.' : 'Le résultat ne correspond pas à celui attendu.',
  };
}

// ── PROF-3 — generated practice specs ──────────────────────────────────────────────────────────────────────────────
// A model proposes the practical exercise of a module; the output is validated and bounded like a verdict. Anything
// invalid is rejected (the caller keeps the generic default spec) — never half-accepted. A model-written `expected`
// answer is dropped: only kinds that can't produce VERIFIED are accepted from a model (see GENERATED_PRACTICE_KINDS).
const GENERATED_KINDS = ['exercise', 'deliverable', 'checklist'];
const MAX_INSTRUCTIONS = 1500;
const MAX_ITEM = 200;
const MAX_CHECKLIST = 6;
const MAX_RUBRIC = 6;

function boundedStringList(value, max) {
  if (value === undefined) return { ok: true, list: [] };
  if (!Array.isArray(value) || value.length > max) return { ok: false };
  const list = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return { ok: false };
    list.push(item.trim().slice(0, MAX_ITEM));
  }
  return { ok: true, list };
}

/** @returns {{ ok: true, spec: { kind, instructions, checklist, rubric, generated: true } } | { ok: false, reason: string }} */
export function validatePracticeSpec(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not_an_object' };
  if (!GENERATED_KINDS.includes(raw.kind)) return { ok: false, reason: 'kind_not_allowed' };
  if (typeof raw.instructions !== 'string' || !raw.instructions.trim()) return { ok: false, reason: 'instructions_missing' };
  const checklist = boundedStringList(raw.checklist, MAX_CHECKLIST);
  if (!checklist.ok) return { ok: false, reason: 'checklist_invalid' };
  const rubric = boundedStringList(raw.rubric, MAX_RUBRIC);
  if (!rubric.ok) return { ok: false, reason: 'rubric_invalid' };
  // exercise / checklist can be self-reported: they need concrete, confirmable checklist points
  if (raw.kind !== 'deliverable' && checklist.list.length === 0) return { ok: false, reason: 'checklist_required' };
  return {
    ok: true,
    spec: {
      kind: raw.kind,
      instructions: raw.instructions.trim().slice(0, MAX_INSTRUCTIONS),
      checklist: raw.kind === 'deliverable' ? [] : checklist.list,
      rubric: rubric.list,
      generated: true,
    },
  };
}

export function buildPracticeSpecPrompt({ subject, registerInstruction, stepTitle, stepSummary, lessonExcerpt }) {
  const lesson = lessonExcerpt ? `\n\nExtrait de la leçon théorique de ce module :\n${lessonExcerpt}` : '';
  return [
    { role: 'system', content: `Tu es un professeur qui conçoit la partie PRATIQUE du module "${stepTitle}" du sujet "${subject}". ${registerInstruction}\n\nPropose UNE mise en pratique concrète et réalisable par l'apprenant (pas un QCM, pas une question de cours). Choisis "kind" parmi :\n- "exercise" : une action réelle à faire (l'apprenant pourra la déclarer faite ou la décrire) ;\n- "deliverable" : un livrable écrit à rendre (texte, code, plan, schéma décrit) ;\n- "checklist" : une suite d'actions concrètes à cocher.\n\nRéponds UNIQUEMENT avec un JSON valide, sans texte autour : {"kind": "exercise"|"deliverable"|"checklist", "instructions": "<consigne claire>", "checklist": ["<point vérifiable>", ...] (2 à ${MAX_CHECKLIST} points, obligatoire sauf pour deliverable), "rubric": ["<critère d'évaluation>", ...] (0 à ${MAX_RUBRIC})}.${lesson}` },
    { role: 'user', content: `Module : "${stepTitle}"${stepSummary ? ` — ${stepSummary}` : ''}` },
  ];
}

// ── PROF-4 — targeted remediation ──────────────────────────────────────────────────────────────────────────────────
// A failing verdict carries a remediation { focus, why, retry } telling the learner WHAT to rework, WHY, and a new
// targeted attempt. It is advisory only: it never changes `passed`, a passing or unusable (invalid) verdict never
// carries one, and a missing/malformed model remediation is replaced by a deterministic one built from the verdict's
// own unmet criteria (or unchecked checklist points) — never from a server-side expected answer.
const MAX_REMEDIATION = 600;

const boundedText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** @returns {{ focus, why, retry, source: 'model' } | null} */
export function validateRemediation(raw) {
  if (!isPlainObject(raw)) return null;
  const focus = boundedText(raw.focus, MAX_NAME);
  const why = boundedText(raw.why, MAX_REMEDIATION);
  const retry = boundedText(raw.retry, MAX_REMEDIATION);
  if (!focus || !why || !retry) return null;
  return { focus, why, retry, source: 'model' };
}

export function deterministicRemediation(verdict, { track }) {
  const unmet = (verdict?.criteria ?? []).filter(c => c.met === false);
  if (verdict?.selfReported) {
    const focus = unmet.map(c => c.name).join(' ; ').slice(0, MAX_NAME) || 'les points de la checklist';
    return { focus, why: 'Ces points de la checklist ne sont pas encore réalisés.', retry: 'Réalise les points restants, puis déclare-les à nouveau.', source: 'checklist' };
  }
  const fallbackFocus = track === 'practice' ? 'la réalisation pratique du module' : 'la notion principale du module';
  const focus = unmet.map(c => c.name).join(' ; ').slice(0, MAX_NAME) || fallbackFocus;
  const why = (unmet.map(c => c.comment).filter(Boolean).join(' ') || verdict?.feedback || 'Ce point n’est pas encore démontré.').slice(0, MAX_REMEDIATION);
  const retry = track === 'practice'
    ? `Reprends l’exercice en te concentrant sur : ${focus}.`
    : `Réponds à nouveau en expliquant précisément : ${focus}.`;
  return { focus, why, retry: retry.slice(0, MAX_REMEDIATION), source: 'criteria' };
}

/** Attaches (failing verdict) or strips (passing / invalid verdict) the remediation. Never touches `passed`. */
export function withRemediation(verdict, { track, rawRemediation } = {}) {
  if (!verdict) return verdict;
  const { remediation: _ignored, ...rest } = verdict; // eslint-disable-line no-unused-vars
  if (rest.passed === true || rest.invalid) return rest;
  return { ...rest, remediation: validateRemediation(rawRemediation) ?? deterministicRemediation(rest, { track }) };
}
