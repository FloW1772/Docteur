/**
 * Agent execution engine + type registry.
 *
 * HOW TO ADD A NEW AGENT TYPE:
 * 1. Add an entry to AGENT_TYPES below with:
 *    - label, description: displayed in the UI
 *    - paramsSchema: array of field descriptors for the UI form
 *    - execute({ params, logger }) → { title, content, kind }   (throws on failure)
 * 2. That's it. The route, scheduler, and UI pick up the new type automatically.
 */

import crypto from 'node:crypto';
import {
  getAllAgents, getLastSuccessfulRun,
  insertAgentRun, updateAgentRun,
  insertAgentOutput, updateAgentLastOutput,
  getCloudKeys, getRouterSettings,
  insertVideoJob, getActiveVideoJob,
  getStyleExampleSettings,
} from './sqlite.js';
import { estimateVideo, runVideoPipeline } from './video-pipeline/pipeline.js';
import { hasActiveJobs } from '../routes/jobs.js';
import {
  completeWithCascade, completeWithGrounding, setGeminiRpm,
} from './providers/gemini.js';
import { buildPersonaToneNote, getPersonaSettings } from './persona.js';
import { assertSafeUrl } from './url-security.js';
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS, normalizeDetailLevel, detailLevelInstruction } from './detail-level.js';
import { findStyleExamples, buildStyleExamplesBlock, describeUsedExamples } from './style-examples.js';

const MAX_ACTIVE_AGENTS  = 10;
const AGENT_TIMEOUT_MS   = 5 * 60 * 1000; // 5 min max per agent run
const SCHEDULER_INTERVAL = 5 * 60 * 1000; // check every 5 min

// ── Frequency helpers ─────────────────────────────────────────────────────────

const FREQUENCY_MS = {
  daily:   24 * 60 * 60 * 1000,
  weekly:   7 * 24 * 60 * 60 * 1000,
};

function isDue(agent, lastRun) {
  if (!lastRun) return true;
  const freq = FREQUENCY_MS[agent.schedule?.frequency];
  if (!freq) return false;
  return (Date.now() - new Date(lastRun.started_at).getTime()) >= freq;
}

// ── Veille (research) execution logic ────────────────────────────────────────
// Re-uses the same Gemini prompts / providers as research.js — no duplication.

function synthesePrompt(subject, detailLevel = 'synthese', styleBlock = '') {
  return `Tu es un expert en veille stratégique et prospective. En te basant sur tes connaissances, produis une synthèse structurée en français sur le sujet suivant :

**${subject}**

${detailLevelInstruction(detailLevel)}${styleBlock}

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

function actualitePrompt(subject, detailLevel = 'synthese', styleBlock = '') {
  return `Fais une recherche web et synthétise les actualités récentes (derniers mois) sur le sujet suivant :

**${subject}**

IMPÉRATIF : Pour chaque information importante, cite la source avec un lien cliquable au format [Titre de la source](URL). Ne mentionne que des faits avec une source web vérifiable.

${detailLevelInstruction(detailLevel)}${styleBlock}

## Actualités récentes
[Informations récentes avec sources]

## Points clés à retenir
[Synthèse des éléments importants]

## Contexte et perspective
[Mise en perspective avec le contexte plus large]

---
*Informations issues de la recherche web — vérifie les sources avant d'agir.*`;
}

const GROUNDING_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// ── Similarity detection ────────────────────────────────────────────────────
// Word-set (Jaccard) similarity — cheap, dependency-free, good enough to spot
// "basically the same synthesis again" without needing an LLM call. The
// title/date header line is stripped first since it always differs and would
// otherwise mask how similar the actual body is.
function stripHeader(content) {
  return String(content ?? '').replace(/^#.*\n\*.*\*\n\n/, '');
}

function wordSet(text) {
  return new Set(
    text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3), // drop short/common words, noisy signal
  );
}

function contentSimilarity(a, b) {
  const setA = wordSet(stripHeader(a));
  const setB = wordSet(stripHeader(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Calibrated empirically, not guessed: two real "synthèse de fond" runs on the
// same subject, back to back, measured ~28% word-overlap — Gemini's sampling
// varies the wording a lot even when the model draws on the same fixed
// knowledge. A threshold near 0.8 would essentially never fire in practice.
// 0.55 leaves clear room above normal same-topic variance while still
// catching genuinely repetitive output (e.g. "actualité" mode finding
// nothing new and re-serving near-identical text).
const SIMILARITY_THRESHOLD = 0.55; // above this, treated as "essentially the same result"

async function runVeille({ subject, mode, detailLevel, useStyleExamples, styleExampleType }, { logger, services }) {
  const settings = getRouterSettings();
  if (settings?.strict_local_mode === true) {
    throw Object.assign(new Error('Mode strictement local activé — agent veille cloud désactivé.'), { strict_local: true });
  }

  const keys = getCloudKeys();
  if (!keys.gemini_key) {
    throw Object.assign(new Error('Clé Gemini non configurée. Ajoute-la dans Paramètres > Fournisseurs cloud.'), { no_key: true });
  }

  setGeminiRpm(settings.gemini_rpm ?? 10);
  const level = normalizeDetailLevel(detailLevel);

  const styleSettings = getStyleExampleSettings();
  let styleBlock = '';
  let usedExamples = [];
  if (styleSettings.enabled && useStyleExamples) {
    const examples = await findStyleExamples(services, { type: styleExampleType, queryText: subject });
    styleBlock = buildStyleExamplesBlock(examples);
    usedExamples = describeUsedExamples(examples);
  }

  // Includes the time (not just the date) so two manual runs on the same day
  // — very common while testing — still get distinct titles.
  const now = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const modeLabel = mode === 'actualite' ? 'actualité web' : 'synthèse de fond';

  const toneNote = buildPersonaToneNote(getPersonaSettings());

  if (mode !== 'actualite') {
    // Mode synthèse — uses completeWithCascade (no grounding)
    const result = await completeWithCascade({
      apiKey:    keys.gemini_key,
      messages:  [
        { role: 'system', content: toneNote },
        { role: 'user',   content: synthesePrompt(subject, level, styleBlock) },
      ],
      maxTokens: 8192,
      logger,
    });
    const title = `Veille — ${subject} (${now})`;
    return {
      title,
      content: `# ${title}\n*Veille automatique · ${modeLabel} · ${now}*\n\n${result.text}`,
      kind:    'recherche',
      metadata: { subject, detailLevel: level, ...(usedExamples.length > 0 ? { style_examples_used: usedExamples } : {}) },
    };
  }

  // Mode actualité — grounding Google Search
  let lastErr;
  for (const model of GROUNDING_MODELS) {
    try {
      const result = await completeWithGrounding({ apiKey: keys.gemini_key, model, prompt: actualitePrompt(subject, level, styleBlock) });
      const title  = `Veille — ${subject} (${now})`;
      return {
        title,
        content: `# ${title}\n*Veille automatique · ${modeLabel} · ${now}*\n\n${result.text}`,
        kind:    'recherche',
        metadata: { subject, detailLevel: level, sources: result.sources ?? [], ...(usedExamples.length > 0 ? { style_examples_used: usedExamples } : {}) },
      };
    } catch (err) {
      lastErr = err;
      if (err.isAuth) throw Object.assign(new Error('Clé Gemini invalide ou révoquée.'), { auth: true });
    }
  }
  throw lastErr ?? new Error('Grounding Google Search indisponible sur ton quota actuel.');
}

// ── Résumé de vidéo longue — ne bloque PAS sur le pipeline complet (des
// heures) : crée le job durable et le lance en tâche de fond, puis retourne
// aussitôt un neurone "placeholder" décrivant le démarrage. Le résultat réel
// (synthèse) arrive plus tard comme un nouveau neurone créé par le pipeline
// lui-même (voir video-pipeline/pipeline.js).
async function runVideoSummaryAgent({ url, resumeType = 'auto', whisperProvider = 'auto', synthesisProvider = 'local' }, { logger, ollamaClient, services }) {
  if (!url?.trim()) throw new Error('Lien vidéo manquant.');
  assertSafeUrl(url);

  const active = getActiveVideoJob();
  if (active || hasActiveJobs()) {
    throw new Error('Un traitement lourd est déjà en cours (résumé de vidéo ou autre lot) — réessaie plus tard.');
  }

  const estimate = await estimateVideo(url);
  const jobId = crypto.randomUUID();
  insertVideoJob({
    id: jobId, url, title: null, status: 'pending',
    provider_whisper: whisperProvider, provider_synthesis: synthesisProvider,
    resume_type: resumeType, duration_s: estimate.ok ? estimate.duration_s : null,
  });

  runVideoPipeline(jobId, { ollamaClient, services, logger }).catch(err => {
    logger?.error({ jobId, err: err.message }, 'VIDEO_PIPELINE_UNCAUGHT_FROM_AGENT');
  });

  const label = estimate.ok ? estimate.duration_label : 'durée inconnue';
  return {
    title: `Résumé de vidéo longue lancé — ${label}`,
    content: `# Résumé de vidéo longue en cours\n\nLe pipeline a démarré pour : ${url}\n\nDurée estimée : ${label}. Suis la progression dans le panneau de résumé de vidéo — un neurone de synthèse sera créé automatiquement à la fin.\n\nJob : ${jobId}`,
    kind: 'video_summary',
    // Marqueur pour executeAgent : ce run n'a pas de "résultat final" au sens
    // classique (pas de comparaison de similarité pertinente, pas de neurone
    // définitif tout de suite) — juste un accusé de lancement.
    isAsyncPipeline: true,
  };
}

// ── Type registry ─────────────────────────────────────────────────────────────

export const AGENT_TYPES = {
  veille: {
    label:       'Veille automatique',
    description: 'Lance une recherche sur un sujet et crée un neurone résumé.',
    paramsSchema: [
      { key: 'subject', label: 'Sujet de veille', type: 'text', required: true, placeholder: 'ex : Intelligence artificielle et éducation' },
      { key: 'mode',    label: 'Mode — synthèse de fond : résultat stable (connaissances figées du modèle) · actualité web : résultat variable (recherche à chaque exécution)', type: 'select', options: [
        { value: 'fond',      label: 'Synthèse de fond (connaissance IA — stable)' },
        { value: 'actualite', label: 'Actualité web (Google Search — variable)' },
      ], default: 'fond' },
      { key: 'skipIfSimilar', label: 'Si le résultat ressemble beaucoup au précédent', type: 'select', options: [
        { value: 'non', label: 'Créer quand même le neurone' },
        { value: 'oui', label: 'Ne pas créer de neurone (juste le signaler)' },
      ], default: 'non' },
      { key: 'detailLevel', label: 'Niveau de détail', type: 'select', options: DETAIL_LEVELS.map(value => ({
        value, label: DETAIL_LEVEL_LABELS[value],
      })), default: 'synthese' },
      { key: 'useStyleExamples', label: 'Utiliser mes exemples de style (si activé dans les réglages)', type: 'select', options: [
        { value: 'non', label: 'Non' },
        { value: 'oui', label: 'Oui' },
      ], default: 'non' },
    ],
    execute: ({ params, logger, services }) => runVeille({
      ...params, useStyleExamples: params?.useStyleExamples === 'oui',
    }, { logger, services }),
  },
  video_summary: {
    label:       'Résumé de vidéo longue',
    description: 'Transcrit et résume une vidéo longue (VOD, conférence) via un pipeline résumable, dans le style de tes exemples de résumé.',
    paramsSchema: [
      { key: 'url', label: 'Lien de la vidéo', type: 'text', required: true, placeholder: 'https://...' },
      { key: 'resumeType', label: 'Type de résumé', type: 'select', options: [
        { value: 'auto',      label: 'Automatique (recherche sémantique du style le plus proche)' },
        { value: 'educatif',  label: 'Éducatif' },
        { value: 'interview', label: 'Interview' },
        { value: 'podcast',   label: 'Podcast' },
        { value: 'rediff',    label: 'Rediff / stream' },
      ], default: 'auto' },
      { key: 'whisperProvider', label: 'Transcription', type: 'select', options: [
        { value: 'auto',  label: 'Auto (Groq si disponible, sinon local)' },
        { value: 'groq',  label: 'Groq (cloud, rapide, quota limité)' },
        { value: 'local', label: 'Whisper local (lent, illimité, privé)' },
      ], default: 'auto' },
      { key: 'synthesisProvider', label: 'Synthèse finale', type: 'select', options: [
        { value: 'local',  label: 'Local (gratuit, privé)' },
        { value: 'groq',   label: 'Groq (cloud)' },
        { value: 'gemini', label: 'Gemini (cloud)' },
      ], default: 'local' },
    ],
    // Ce type NE respecte PAS le timeout de 5 min de executeAgent (voir plus
    // bas) : execute() ne fait que démarrer le pipeline durable et retourne
    // aussitôt — le pipeline continue en tâche de fond après le retour.
    skipTimeout: true,
    execute: ({ params, logger, ollamaClient, services }) => runVideoSummaryAgent(params, { logger, ollamaClient, services }),
  },
};

// ── Single agent execution ────────────────────────────────────────────────────

export async function executeAgent(agent, { triggeredBy = 'manual', logger, ollamaClient, services } = {}) {
  const type = AGENT_TYPES[agent.type];
  if (!type) throw new Error(`Type d'agent inconnu : ${agent.type}`);

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  insertAgentRun({ id: runId, agent_id: agent.id, started_at: startedAt, triggered_by: triggeredBy });

  let output;
  try {
    // Types marqués skipTimeout (ex. video_summary) démarrent un pipeline
    // durable de plusieurs heures et retournent vite — les faire courir dans
    // la course de 5 min du Promise.race ci-dessous les ferait échouer alors
    // que le pipeline lui-même continuerait en arrière-plan sans que
    // l'agent_run le reflète correctement. On les exécute donc sans timeout.
    if (type.skipTimeout) {
      output = await type.execute({ params: agent.params, logger, ollamaClient, services });
    } else {
      const timeoutPromise = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Timeout : l\'agent a dépassé 5 minutes.')), AGENT_TIMEOUT_MS),
      );
      output = await Promise.race([
        type.execute({ params: agent.params, logger, ollamaClient, services }),
        timeoutPromise,
      ]);
    }
  } catch (err) {
    updateAgentRun(runId, {
      finished_at:   new Date().toISOString(),
      status:        'error',
      error_message: err.message ?? String(err),
    });
    logger?.warn({ agentId: agent.id, type: agent.type, err: err.message, triggeredBy }, 'agent run failed');
    throw err;
  }

  // Compare against the last run that actually produced a neuron — never
  // against a run that was itself skipped, so a string of similar runs
  // doesn't drift the baseline. First run for an agent has nothing to
  // compare against (agent.last_output_content is null).
  let similarityNote = null;
  let skipped = false;
  if (agent.last_output_content) {
    const similarity = contentSimilarity(agent.last_output_content, output.content);
    if (similarity >= SIMILARITY_THRESHOLD) {
      const pct = Math.round(similarity * 100);
      const wantsSkip = agent.params?.skipIfSimilar === 'oui';
      similarityNote = wantsSkip
        ? `Résultat très similaire à la veille précédente (~${pct}% de contenu commun) — neurone non créé.`
        : `Résultat similaire à la veille précédente (~${pct}% de contenu commun).`;
      skipped = wantsSkip;
    }
  }

  updateAgentRun(runId, {
    finished_at:     new Date().toISOString(),
    status:          'success',
    output_title:    output.title,
    similarity_note: similarityNote,
  });

  if (!skipped) {
    updateAgentLastOutput(agent.id, output.content);

    // For scheduled runs: store output for the client to pick up on next load
    if (triggeredBy !== 'manual') {
      insertAgentOutput({
        id:        crypto.randomUUID(),
        agent_id:  agent.id,
        run_id:    runId,
        title:     output.title,
        content:   output.content,
        kind:      output.kind ?? 'recherche',
        created_at: new Date().toISOString(),
      });
    }
  }

  logger?.info({ agentId: agent.id, type: agent.type, title: output.title, triggeredBy, skipped, similar: !!similarityNote }, 'agent run success');
  return { runId, output, skipped, similarityNote };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let schedulerTimer = null;

export function startAgentScheduler({ logger, ollamaClient, services } = {}) {
  if (schedulerTimer) return; // already running

  async function tick() {
    const agents = getAllAgents().filter(a => a.active && a.trigger_type === 'scheduled');
    if (agents.length === 0) return;

    let ran = 0;
    for (const agent of agents) {
      if (ran >= MAX_ACTIVE_AGENTS) break;
      try {
        const lastRun = getLastSuccessfulRun(agent.id);
        if (!isDue(agent, lastRun)) continue;
        logger?.info({ agentId: agent.id, name: agent.name }, 'agent scheduler: running due agent');
        await executeAgent(agent, { triggeredBy: 'schedule', logger, ollamaClient, services });
        ran++;
      } catch (err) {
        // error already recorded in agent_runs; keep going
        logger?.warn({ agentId: agent.id, err: err.message }, 'agent scheduler: run failed, continuing');
      }
    }
  }

  // Run once at startup for catchup (after a short delay to let server settle)
  setTimeout(tick, 10_000);

  schedulerTimer = setInterval(tick, SCHEDULER_INTERVAL);
  logger?.info({ intervalMs: SCHEDULER_INTERVAL }, 'agent scheduler started');
}

export function stopAgentScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
