// POST /api/candidature/analyze  — deep CV analysis, 100% local Ollama only
// POST /api/candidature/rewrite  — CV rewriting, 100% local Ollama only
// POST /api/candidature/letter   — cover letter / motivation email, 100% local Ollama only
//
// SECURITY NOTE: these routes NEVER call routedCompletion or any cloud provider.
// Personal CV data must stay on device at all times.

import { Hono } from 'hono';
import { insertActivityLog } from '../lib/sqlite.js';

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildAnalyzePrompt(cvContent) {
  return `Tu es un consultant RH expert et un coach en recrutement reconnu pour la qualité de tes analyses de CV. Ton travail est d'analyser ce CV de façon EXHAUSTIVE et HONNÊTE. Ne sois pas complaisant : un CV médiocre doit être critiqué clairement. Ne flatte pas.

RÈGLES ABSOLUES :
- Ne jamais inventer d'expérience, de diplôme ou de compétence absents du CV
- Analyser uniquement ce qui est écrit, rien de plus
- Être direct, même si c'est difficile à lire
- Chaque observation doit être ancrée dans le texte du CV

CV À ANALYSER :
"""
${cvContent}
"""

Produis un rapport structuré en FRANÇAIS avec exactement ces 6 sections :

# 1. LISIBILITÉ ET FORME
- Structure et organisation (hiérarchie de l'information, clarté visuelle)
- Ce qui frappe en 10 secondes de lecture
- Longueur et densité (trop court, trop long, trop dense ?)
- Cohérence chronologique, trous inexpliqués ou zones d'ombre

# 2. FOND ET CONTENU
- Compétences clairement DÉMONTRÉES vs simplement AFFIRMÉES (exemples précis du CV)
- Réalisations chiffrées présentes vs descriptions de tâches vagues
- Mots-clés métier présents et manquants
- Adéquation entre le parcours et l'objectif affiché

# 3. POINTS FORTS À VALORISER
- Ce qui différencie vraiment ce profil des autres candidats
- Éléments sous-exploités qui mériteraient d'être mis en avant
- Arguments les plus solides pour un recruteur

# 4. POINTS FAIBLES ET RISQUES
- Ce qu'un recruteur expérimenté pourrait questionner ou juger négativement
- Formulations vagues, jargon creux, clichés à éviter
- Éléments datés ou potentiellement discriminants
- Risques d'élimination au premier tri

# 5. QUESTIONS D'ENTRETIEN PROBABLES (minimum 15 questions)
Pour chaque question, indique la catégorie [PARCOURS], [TECHNIQUE], [COMPORTEMENTAL] ou [PIÈGE], puis une piste de réponse basée sur les éléments réels du CV.

Inclure obligatoirement :
- Des questions sur les trous ou changements de cap constatés dans le CV
- Des questions difficiles sur les éventuels échecs ou limites apparentes
- Une question sur les prétentions salariales

Format strict pour chaque question :
**[Question ?]** [CATÉGORIE]
→ Piste : ...

# 6. SUGGESTIONS CONCRÈTES DE RÉÉCRITURE (minimum 5 suggestions)
Pour chaque point faible identifié, propose une reformulation.

Format strict :
**AVANT :** [formulation actuelle tirée du CV]
**APRÈS :** [formulation améliorée]
**POURQUOI :** [explication brève]`;
}

function buildRewritePrompt(cvContent, targetJob, jobOffer) {
  const targetBlock = targetJob || jobOffer
    ? `\n\n═══ CIBLAGE DU POSTE ═══
${targetJob ? `Poste visé : ${targetJob}` : ''}
${jobOffer ? `\nOffre d'emploi :\n"""\n${jobOffer}\n"""\n\nInstructions ciblage :\n- Réordonne les sections et les expériences pour mettre EN AVANT ce qui correspond à l'offre\n- Reprends les mots-clés exacts de l'offre dans les formulations (sans mentir)\n- Mets en tête les compétences directement demandées` : ''}`
    : '';

  return `Tu es un recruteur sénior avec 15 ans d'expérience dans l'optimisation de CV. En ce moment, tu RÉÉCRIS réellement ce CV, mot par mot. Tu n'expliques pas, tu ne donnes pas de conseils : tu produis le document final.

═══ RÈGLES ABSOLUES ═══
- JAMAIS inventer une expérience, un diplôme, un employeur, une compétence, une date ou un chiffre absent de l'original
- Si un chiffre manque mais est attendu : écrire [A COMPLETER : préciser le nombre / le pourcentage / le budget]
- Si une information est absente : écrire [A COMPLETER : ajouter ici]
- Conserver TOUTES les expériences et formations sans en supprimer une seule
- Ne pas embellir mensongèrement (pas "expert mondial" si ce n'est pas dit)${targetBlock}

═══ CE QUE TU DOIS FAIRE CONCRÈTEMENT ═══
1. Transformer chaque description de TÂCHE en RÉALISATION
   Avant : "Gestion des stocks"
   Après : "Réduction des ruptures de stock de [A COMPLETER : X%] par la mise en place d'un suivi hebdomadaire des rotations"

2. Remplacer les verbes faibles par des verbes d'action forts
   À éliminer : "responsable de", "participé à", "impliqué dans", "a travaillé sur"
   À utiliser : dirigé, développé, réduit, augmenté, négocié, conçu, déployé, formé, piloté, optimisé

3. Supprimer les formulations creuses
   À éliminer : "passionné par", "dynamique", "team player", "force de proposition", "rigoureux et organisé"
   Remplacer par des preuves concrètes tirées du CV ou [A COMPLETER]

4. Restructurer l'ordre des sections selon leur force
   (Ordre suggéré : identité/accroche → expériences en commençant par la plus pertinente → formations → compétences → autres)

5. Harmoniser style, temps (passé composé ou infinitif), ponctuation

═══ FORMAT DE SORTIE OBLIGATOIRE ═══
Utilise EXACTEMENT ces deux balises, dans cet ordre :

===CV RÉÉCRIT===
[Le CV complet réécrit, section par section, immédiatement exploitable tel quel]

===CHANGEMENTS===
[Liste des 5 à 10 principaux changements effectués, au format :
- AVANT : [formulation originale] → APRÈS : [nouvelle formulation] — POURQUOI : [raison]]

CV ORIGINAL À RÉÉCRIRE :
"""
${cvContent}
"""

COMMENCE PAR ===CV RÉÉCRIT=== MAINTENANT. PREMIER MOT = NOM DU CANDIDAT (ou de la première section si pas de nom).`;
}

function buildRewriteRetryPrompt(cvContent, firstAttempt) {
  return `Tu as produit une réponse incorrecte. Au lieu de réécrire le CV, tu as produit des CONSEILS ou un plan. Ce n'est PAS ce qui est demandé.

RECOMMENCE IMMÉDIATEMENT. Produis LE CV COMPLET RÉÉCRIT.

Règles identiques :
- Pas d'introduction, pas de conseils, pas d'explication
- Commence DIRECTEMENT par ===CV RÉÉCRIT===
- Contenu : le CV réécrit mot par mot, section par section
- Ensuite ===CHANGEMENTS=== avec les transformations listées

CV ORIGINAL :
"""
${cvContent}
"""

===CV RÉÉCRIT===`;
}

// Détecte si le modèle a produit des conseils au lieu d'un CV réécrit
function looksLikeAdvice(text) {
  const lower = (text ?? '').toLowerCase().slice(0, 800);
  const adviceMarkers = [
    'voici quelques', 'je vous recommande', 'il serait préférable', 'il serait judicieux',
    'vous devriez', 'pour améliorer', 'voici comment', 'suggestions', 'conseils',
    'recommandation', 'points à améliorer', 'il faudrait', 'pensez à',
  ];
  const cvStructure = ['expérience', 'formation', 'compétences', 'poste chez', 'entreprise', '[a completer'];
  const hasAdvice  = adviceMarkers.some(p => lower.includes(p));
  const hasSection = cvStructure.some(t => lower.includes(t));
  // Advice-like AND no CV structure AND doesn't start with the expected header
  return hasAdvice && !hasSection && !lower.startsWith('===cv');
}

// Sépare le CV réécrit et la section changements depuis la sortie du modèle
function parseRewriteOutput(text) {
  const t = (text ?? '').trim();
  const cvMatch      = t.match(/===CV RÉÉCRIT===([\s\S]*?)(?:===CHANGEMENTS===|$)/i);
  const changesMatch = t.match(/===CHANGEMENTS===([\s\S]*)$/i);
  const rewrittenCv  = (cvMatch?.[1] ?? t).trim();
  const changes      = (changesMatch?.[1] ?? '').trim();
  return { rewrittenCv, changes };
}

function buildTargetJobsPrompt(cvContent) {
  return `Tu es un recruteur expérimenté avec 20 ans de terrain dans plusieurs secteurs. Tu examines ce CV et identifies les postes pour lesquels ce profil est objectivement qualifié — sans flatterie, sans invention.

RÈGLES ABSOLUES :
- Fonde-toi UNIQUEMENT sur ce qui est écrit dans le CV
- Ne jamais inventer de compétence, d'expérience ou de diplôme
- Signale clairement ce qui manque pour chaque poste si pertinent
- Utilise les intitulés de poste réels du marché du travail français

CV À ANALYSER :
"""
${cvContent}
"""

Produis une analyse structurée en FRANÇAIS avec EXACTEMENT ces 3 catégories, entre 15 et 20 intitulés au total :

## ✅ ÉVIDENT — Postes directement accessibles (correspondance 80-100%)

Pour chaque poste :
**[Intitulé exact du poste]**
→ Pourquoi : [2-3 raisons fondées sur des éléments précis du CV]
→ Manques : [ce qui est absent, ou "Profil complet pour ce poste" si rien ne manque]

## 🎯 ACCESSIBLE — Postes atteignables avec une bonne mise en valeur (60-80%)

Même format.

## 📈 EFFORT REQUIS — Postes visables avec expérience ou formation complémentaire (<60%)

Même format + indique précisément ce qu'il faudrait combler.

---
Classe les postes du plus au moins pertinent au sein de chaque catégorie.
15 à 20 intitulés au total, répartis entre les 3 catégories.`;
}

function buildAtsKeywordsPrompt(cvContent) {
  return `Tu es un expert en optimisation de CV pour les logiciels ATS (Applicant Tracking Systems). Tu analyses ce CV pour identifier les mots-clés critiques.

RÈGLE ABSOLUE : ne jamais suggérer d'ajouter un mot-clé si la compétence correspondante n'est pas clairement démontrée ou implicite dans le CV.

CV À ANALYSER :
"""
${cvContent}
"""

Produis un rapport en FRANÇAIS avec exactement ces 4 sections :

## 1. ✅ MOTS-CLÉS DÉJÀ PRÉSENTS

Pour chaque mot-clé important détecté :
**[mot-clé / expression métier]** — Contexte : "[extrait exact ou reformulation tirée du CV]"

## 2. ➕ MOTS-CLÉS À AJOUTER LÉGITIMEMENT

Mots-clés que le candidat peut ajouter SANS MENTIR (la compétence existe, même implicitement).
**[mot-clé]**
→ Pourquoi légitime : [lien avec un élément réel du CV]
→ Où insérer : [section suggérée + formulation exemple]

## 3. ⛔ MOTS-CLÉS À ÉVITER (absent du profil réel)

Mots-clés courants dans ce domaine mais que le CV ne justifie pas.
**[mot-clé]** — Pourquoi ne pas l'ajouter : [explication honnête]

## 4. 📐 OPTIMISATIONS FORMAT ATS

3 à 5 conseils concrets sur la structure du document pour maximiser le score ATS (titres, ponctuation, ordre des sections, éviter les tableaux, etc.).`;
}

function buildMasterCvPrompt(cvContent) {
  return `Tu es un expert en rédaction de CV. Tu crées un CV MASTER — version exhaustive et complète du parcours, conçue pour être facilement déclinée et raccourcie selon les postes.

RÈGLES ABSOLUES :
- Conserver TOUTES les expériences et formations présentes dans le CV source, sans exception
- Ne jamais inventer d'information, de date, d'employeur, de chiffre
- Si un chiffre ou une information précise manque et serait attendu : écrire [A COMPLETER : ...]
- Format modulaire : chaque expérience est un bloc autonome pouvant être copié ou supprimé
- Verbes d'action forts, formulations orientées résultats

CV SOURCE :
"""
${cvContent}
"""

Produis un CV MASTER COMPLET en FRANÇAIS avec ce format EXACTEMENT :

===CV MASTER===

## EN-TÊTE
[Prénom NOM]
[Titre professionnel principal — reflet fidèle du parcours]
[Coordonnées si présentes dans le CV, sinon : [A COMPLETER : email, téléphone, LinkedIn]]

## PROFIL SYNTHÈSE
[3-4 lignes : qui est le candidat, sa valeur ajoutée, son niveau d'expérience — strictement fondé sur le CV]

## COMPÉTENCES CLÉS
[Thématisées par domaine si plusieurs secteurs, sinon liste structurée]

## EXPÉRIENCES PROFESSIONNELLES

### [Titre du poste] — [Entreprise] — [Dates de début à fin]
*[Secteur / taille d'entreprise si mentionné dans le CV]*
- [Réalisation 1 avec verbe d'action fort]
- [Réalisation 2]
- [Réalisation 3 ou plus si disponibles dans le CV]
[A COMPLETER : préciser l'impact chiffré si non mentionné dans le CV original]

[Répéter pour chaque expérience, chronologie inversée]

## FORMATIONS
[Diplômes et certifications, chronologie inversée]
### [Diplôme / Certification] — [Établissement] — [Année]

## AUTRES
[Langues, permis, bénévolat, publications, centres d'intérêt pertinents — tout ce qui figure dans le CV]

===GUIDE DE DÉCLINAISON===
[3 conseils concrets sur comment raccourcir ce CV master selon les types de postes — ex : supprimer les expériences de plus de 10 ans pour un poste junior, conserver seulement les compétences pertinentes, etc.]

COMMENCE PAR ===CV MASTER=== MAINTENANT.`;
}

function buildAdaptCvPrompt(masterCvContent, jobOffer) {
  return `Tu es un recruteur sénior. Tu adaptes un CV pour une offre d'emploi précise en réordonnant, reformulant et sélectionnant — jamais en inventant.

RÈGLES ABSOLUES :
- Ne jamais inventer d'expérience, compétence ou diplôme absent du CV
- Réordonner, reformuler, sélectionner parmi ce qui existe
- Informations manquantes pour le poste = [A COMPLETER : ...]
- Le score d'adéquation est réaliste et honnête, pas flatteur

CV MASTER :
"""
${masterCvContent}
"""

OFFRE D'EMPLOI :
"""
${jobOffer}
"""

Produis EXACTEMENT ce format, dans cet ordre :

===SCORE D'ADÉQUATION===
[Score sur 100 — ex : 72/100]
[Phrase d'explication directe : ce qui plaide pour ce score, sans fioritures]

===CV ADAPTÉ===
[CV complet réécrit et adapté à l'offre :
- Expériences les plus pertinentes pour ce poste placées en tête
- Vocabulaire et mots-clés exacts de l'offre intégrés (sans mensonge)
- Éléments non pertinents raccourcis ou retirés
- Compétences clés de l'offre mises en avant si présentes dans le CV
- Profil synthèse réorienté vers ce poste]

===CE QUI MANQUE===
[Éléments demandés dans l'offre qui sont absents ou insuffisamment démontrés dans le CV.
Pour chaque manque :
**[Élément manquant]**
→ Importance pour ce poste : [haute / moyenne / faible]
→ Note : [action concrète et réaliste pour combler, ou "difficile à combler rapidement"]]

===MOTS-CLÉS DE L'OFFRE INTÉGRÉS===
[Liste simple des mots-clés de l'offre que tu as effectivement intégrés dans le CV adapté]

COMMENCE PAR ===SCORE D'ADÉQUATION=== MAINTENANT.`;
}

function parseAdaptOutput(text) {
  const t = (text ?? '').trim();
  const scoreMatch     = t.match(/===SCORE D'AD[ÉE]QUATION===([\s\S]*?)(?:===CV ADAPT[ÉE]===|$)/i);
  const adaptedMatch   = t.match(/===CV ADAPT[ÉE]===([\s\S]*?)(?:===CE QUI MANQUE===|$)/i);
  const missingMatch   = t.match(/===CE QUI MANQUE===([\s\S]*?)(?:===MOTS-CL[ÉE]S|$)/i);
  const keywordsMatch  = t.match(/===MOTS-CL[ÉE]S[^=]*===([\s\S]*)$/i);
  return {
    adequation_score: (scoreMatch?.[1] ?? '').trim(),
    adapted_cv:       (adaptedMatch?.[1] ?? t).trim(),
    missing:          (missingMatch?.[1] ?? '').trim(),
    keywords_used:    (keywordsMatch?.[1] ?? '').trim(),
  };
}

function parseMasterCvOutput(text) {
  const t = (text ?? '').trim();
  const masterMatch = t.match(/===CV MASTER===([\s\S]*?)(?:===GUIDE|$)/i);
  const guideMatch  = t.match(/===GUIDE DE D[ÉE]CLINAISON===([\s\S]*)$/i);
  return {
    master_cv: (masterMatch?.[1] ?? t).trim(),
    guide:     (guideMatch?.[1] ?? '').trim(),
  };
}

function buildLetterPrompt({ cvContent, format, mode, company, jobTitle, jobOffer }) {
  const formatDesc = format === 'email'
    ? 'un mail de motivation court et percutant (150 à 200 mots maximum, ton direct et professionnel)'
    : 'une lettre de motivation classique (300 à 400 mots, structure en 3 paragraphes)';

  const modeDesc = mode === 'ciblee'
    ? `une candidature ciblée pour : ${company ? `l'entreprise ${company}` : 'une entreprise'}${jobTitle ? `, poste : ${jobTitle}` : ''}`
    : 'une candidature générique, réutilisable et adaptable';

  return `Tu es un expert en rédaction de lettres de motivation et de mails professionnels. Tu vas rédiger ${formatDesc} pour ${modeDesc}.

RÈGLES ABSOLUES :
- N'invente aucune compétence ou expérience absente du CV
- Sois direct et concret, évite les formules creuses et les clichés
- Chaque argument doit être ancré dans un élément réel et précis du CV
- Ne commence JAMAIS par "Je me permets de vous contacter" ou "Madame, Monsieur"

CV DU CANDIDAT :
"""
${cvContent}
"""
${mode === 'ciblee' && jobOffer ? `
OFFRE D'EMPLOI CIBLÉE :
"""
${jobOffer}
"""

Fais le lien EXPLICITE et PRÉCIS entre les éléments du CV et les compétences/attentes décrites dans l'offre.` : ''}

Format attendu :
${format === 'email'
    ? `Objet : [ligne d'objet concise et percutante]

[Corps du mail en 150-200 mots]

Cordialement,
[Prénom Nom]`
    : `[Lieu], le [Date]

[En-tête : Nom / Prénom / Coordonnées]

[Accroche percutante — 1 phrase qui capte l'attention]

[Paragraphe 1 — Pourquoi ce poste / cette entreprise ?]

[Paragraphe 2 — Ce que j'apporte : preuves concrètes tirées du CV]

[Paragraphe 3 — Conclusion et appel à l'action]

Cordialement,
[Prénom Nom]`}

Commence directement par le document, sans explication préalable.`;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createCandidatureRoute({ logger, runLocalStandard, runLocalPowerful, ensureOllamaAvailableOrThrow }) {
  const route = new Hono();

  // ── POST /api/candidature/analyze ──────────────────────────────────────────
  route.post('/candidature/analyze', async (c) => {
    const body       = await c.req.json().catch(() => null);
    const cvContent  = String(body?.cv_content ?? '').trim();
    const powerful   = body?.powerful === true;

    if (!cvContent) return c.json({ error: 'cv_content requis' }, 400);

    c.set('requestPayload', { cv_length: cvContent.length, powerful });
    const started = Date.now();

    try {
      await ensureOllamaAvailableOrThrow();
      const messages = [
        { role: 'system', content: 'Tu es un consultant RH expert. Réponds uniquement en français. Sois honnête et critique.' },
        { role: 'user',   content: buildAnalyzePrompt(cvContent) },
      ];

      const { text: report, model } = powerful
        ? await runLocalPowerful(messages)
        : await runLocalStandard(messages);

      c.set('modelUsed', model);
      if (logger) logger.info({ cv_length: cvContent.length, model, powerful }, 'CV_ANALYZE_DONE');
      // Journal : jamais le contenu du CV, uniquement le fait que l'opération a eu lieu.
      insertActivityLog({ opType: 'cv_analyze', item: 'Analyse CV', result: 'success', durationMs: Date.now() - started, modelUsed: model });
      return c.json({ report, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_ANALYZE_ERROR');
      insertActivityLog({ opType: 'cv_analyze', item: 'Analyse CV', result: 'failure', reason: err.message, durationMs: Date.now() - started });
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/candidature/rewrite ─────────────────────────────────────────
  route.post('/candidature/rewrite', async (c) => {
    const body      = await c.req.json().catch(() => null);
    const cvContent = String(body?.cv_content ?? '').trim();
    const targetJob = String(body?.target_job  ?? '').trim() || undefined;
    const jobOffer  = String(body?.job_offer   ?? '').trim() || undefined;
    const powerful  = body?.powerful === true;

    if (!cvContent) return c.json({ error: 'cv_content requis' }, 400);

    c.set('requestPayload', { cv_length: cvContent.length, target_job: targetJob, powerful });
    const started = Date.now();

    try {
      await ensureOllamaAvailableOrThrow();

      const run = powerful ? runLocalPowerful : runLocalStandard;

      // ── Attempt 1 ──────────────────────────────────────────────────────────
      const messages1 = [
        { role: 'system', content: 'Tu es un recruteur sénior expert en rédaction de CV. Tu produis des CV complets et professionnels. Réponds uniquement en français. Tu ne donnes jamais de conseils — tu réécris.' },
        { role: 'user',   content: buildRewritePrompt(cvContent, targetJob, jobOffer) },
      ];
      const { text: raw1, model } = await run(messages1);

      let finalText = raw1;

      // ── Retry si le modèle a produit des conseils au lieu d'un CV ─────────
      if (looksLikeAdvice(raw1)) {
        if (logger) logger.warn({ cv_length: cvContent.length }, 'CV_REWRITE_RETRY: advice detected, retrying');
        const messages2 = [
          { role: 'system', content: 'Tu réécris des CV. Tu produis UNIQUEMENT le document final, jamais de conseils. Réponds en français.' },
          { role: 'user',   content: buildRewriteRetryPrompt(cvContent, raw1) },
        ];
        const { text: raw2 } = await run(messages2);
        finalText = raw2;
      }

      const { rewrittenCv, changes } = parseRewriteOutput(finalText);

      c.set('modelUsed', model);
      if (logger) logger.info({ cv_length: cvContent.length, model, target_job: targetJob, targeted: !!(targetJob || jobOffer) }, 'CV_REWRITE_DONE');
      insertActivityLog({ opType: 'cv_rewrite', item: 'Réécriture CV', result: 'success', durationMs: Date.now() - started, modelUsed: model });
      return c.json({ rewritten_cv: rewrittenCv, changes, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_REWRITE_ERROR');
      insertActivityLog({ opType: 'cv_rewrite', item: 'Réécriture CV', result: 'failure', reason: err.message, durationMs: Date.now() - started });
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/candidature/letter ──────────────────────────────────────────
  route.post('/candidature/letter', async (c) => {
    const body      = await c.req.json().catch(() => null);
    const cvContent = String(body?.cv_content  ?? '').trim();
    const format    = body?.format === 'email' ? 'email' : 'lettre';
    const mode      = body?.mode   === 'ciblee' ? 'ciblee' : 'generique';
    const company   = String(body?.company   ?? '').trim() || undefined;
    const jobTitle  = String(body?.job_title ?? '').trim() || undefined;
    const jobOffer  = String(body?.job_offer ?? '').trim() || undefined;
    const powerful  = body?.powerful === true;

    if (!cvContent) return c.json({ error: 'cv_content requis' }, 400);

    c.set('requestPayload', { cv_length: cvContent.length, format, mode, company, powerful });

    try {
      await ensureOllamaAvailableOrThrow();
      const messages = [
        { role: 'system', content: 'Tu es un expert en rédaction de lettres de motivation et mails professionnels. Réponds uniquement en français.' },
        { role: 'user',   content: buildLetterPrompt({ cvContent, format, mode, company, jobTitle, jobOffer }) },
      ];

      const { text: letter, model } = powerful
        ? await runLocalPowerful(messages)
        : await runLocalStandard(messages);

      // Generate a meaningful title for the neuron
      const titleParts = [];
      if (format === 'email') titleParts.push('Mail');
      else titleParts.push('Lettre');
      if (mode === 'ciblee' && company) titleParts.push(`— ${company}`);
      if (mode === 'ciblee' && jobTitle) titleParts.push(`· ${jobTitle}`);
      if (mode === 'generique') titleParts.push('— générique');
      const title = titleParts.join(' ');

      c.set('modelUsed', model);
      if (logger) logger.info({ format, mode, company, model }, 'CV_LETTER_DONE');
      return c.json({ letter, title, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_LETTER_ERROR');
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/candidature/target-jobs ────────────────────────────────────
  route.post('/candidature/target-jobs', async (c) => {
    const body      = await c.req.json().catch(() => null);
    const cvContent = String(body?.cv_content ?? '').trim();
    const powerful  = body?.powerful === true;
    if (!cvContent) return c.json({ error: 'cv_content requis' }, 400);
    c.set('requestPayload', { cv_length: cvContent.length, powerful });
    try {
      await ensureOllamaAvailableOrThrow();
      const messages = [
        { role: 'system', content: 'Tu es un recruteur expérimenté. Analyse les CV honnêtement et sans flatterie. Réponds uniquement en français.' },
        { role: 'user',   content: buildTargetJobsPrompt(cvContent) },
      ];
      const { text: report, model } = powerful ? await runLocalPowerful(messages) : await runLocalStandard(messages);
      c.set('modelUsed', model);
      if (logger) logger.info({ cv_length: cvContent.length, model }, 'CV_TARGET_JOBS_DONE');
      return c.json({ report, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_TARGET_JOBS_ERROR');
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/candidature/ats-keywords ───────────────────────────────────
  route.post('/candidature/ats-keywords', async (c) => {
    const body      = await c.req.json().catch(() => null);
    const cvContent = String(body?.cv_content ?? '').trim();
    const powerful  = body?.powerful === true;
    if (!cvContent) return c.json({ error: 'cv_content requis' }, 400);
    c.set('requestPayload', { cv_length: cvContent.length, powerful });
    try {
      await ensureOllamaAvailableOrThrow();
      const messages = [
        { role: 'system', content: 'Tu es un expert ATS et optimisation de CV. Réponds uniquement en français. Ne suggère jamais un mot-clé mensonger.' },
        { role: 'user',   content: buildAtsKeywordsPrompt(cvContent) },
      ];
      const { text: report, model } = powerful ? await runLocalPowerful(messages) : await runLocalStandard(messages);
      c.set('modelUsed', model);
      if (logger) logger.info({ cv_length: cvContent.length, model }, 'CV_ATS_KEYWORDS_DONE');
      return c.json({ report, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_ATS_KEYWORDS_ERROR');
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/candidature/master-cv ──────────────────────────────────────
  route.post('/candidature/master-cv', async (c) => {
    const body      = await c.req.json().catch(() => null);
    const cvContent = String(body?.cv_content ?? '').trim();
    const powerful  = body?.powerful === true;
    if (!cvContent) return c.json({ error: 'cv_content requis' }, 400);
    c.set('requestPayload', { cv_length: cvContent.length, powerful });
    try {
      await ensureOllamaAvailableOrThrow();
      const messages = [
        { role: 'system', content: 'Tu es un expert en rédaction de CV. Tu produis des documents complets et modulaires. Réponds uniquement en français. Tu ne donnes jamais de conseils — tu produis le document final.' },
        { role: 'user',   content: buildMasterCvPrompt(cvContent) },
      ];
      const { text: raw, model } = powerful ? await runLocalPowerful(messages) : await runLocalStandard(messages);
      const { master_cv, guide } = parseMasterCvOutput(raw);
      c.set('modelUsed', model);
      if (logger) logger.info({ cv_length: cvContent.length, model }, 'CV_MASTER_DONE');
      return c.json({ master_cv, guide, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_MASTER_ERROR');
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/candidature/adapt-cv ───────────────────────────────────────
  route.post('/candidature/adapt-cv', async (c) => {
    const body             = await c.req.json().catch(() => null);
    const masterCvContent  = String(body?.master_cv_content ?? '').trim();
    const jobOffer         = String(body?.job_offer         ?? '').trim();
    const powerful         = body?.powerful === true;
    if (!masterCvContent) return c.json({ error: 'master_cv_content requis' }, 400);
    if (!jobOffer)        return c.json({ error: 'job_offer requis' }, 400);
    c.set('requestPayload', { cv_length: masterCvContent.length, offer_length: jobOffer.length, powerful });
    try {
      await ensureOllamaAvailableOrThrow();
      const messages = [
        { role: 'system', content: 'Tu es un recruteur sénior expert en adaptation de CV. Tu produis des documents adaptés à des offres précises. Réponds uniquement en français. Tu ne donnes jamais de conseils — tu produis le document final.' },
        { role: 'user',   content: buildAdaptCvPrompt(masterCvContent, jobOffer) },
      ];
      const { text: raw, model } = powerful ? await runLocalPowerful(messages) : await runLocalStandard(messages);
      const { adequation_score, adapted_cv, missing, keywords_used } = parseAdaptOutput(raw);
      c.set('modelUsed', model);
      if (logger) logger.info({ cv_length: masterCvContent.length, offer_length: jobOffer.length, model }, 'CV_ADAPT_DONE');
      return c.json({ adequation_score, adapted_cv, missing, keywords_used, model_used: model }, 200);
    } catch (err) {
      if (logger) logger.error({ error_message: err.message }, 'CV_ADAPT_ERROR');
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
