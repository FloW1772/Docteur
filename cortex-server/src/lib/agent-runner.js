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
  insertAgentOutput,
  getCloudKeys, getRouterSettings,
} from './sqlite.js';
import {
  completeWithCascade, completeWithGrounding, setGeminiRpm,
} from './providers/gemini.js';
import { buildPersonaToneNote, getPersonaSettings } from './persona.js';

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

IMPÉRATIF : Pour chaque information importante, cite la source avec un lien cliquable au format [Titre de la source](URL). Ne mentionne que des faits avec une source web vérifiable.

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

async function runVeille({ subject, mode }, { logger }) {
  const settings = getRouterSettings();
  if (settings?.strict_local_mode === true) {
    throw Object.assign(new Error('Mode strictement local activé — agent veille cloud désactivé.'), { strict_local: true });
  }

  const keys = getCloudKeys();
  if (!keys.gemini_key) {
    throw Object.assign(new Error('Clé Gemini non configurée. Ajoute-la dans Paramètres > Fournisseurs cloud.'), { no_key: true });
  }

  setGeminiRpm(settings.gemini_rpm ?? 10);

  const now = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const modeLabel = mode === 'actualite' ? 'actualité web' : 'synthèse de fond';

  const toneNote = buildPersonaToneNote(getPersonaSettings());

  if (mode !== 'actualite') {
    // Mode synthèse — uses completeWithCascade (no grounding)
    const result = await completeWithCascade({
      apiKey:    keys.gemini_key,
      messages:  [
        { role: 'system', content: toneNote },
        { role: 'user',   content: synthesePrompt(subject) },
      ],
      maxTokens: 8192,
      logger,
    });
    const title = `Veille — ${subject} (${now})`;
    return {
      title,
      content: `# ${title}\n*Veille automatique · ${modeLabel} · ${now}*\n\n${result.text}`,
      kind:    'recherche',
    };
  }

  // Mode actualité — grounding Google Search
  let lastErr;
  for (const model of GROUNDING_MODELS) {
    try {
      const result = await completeWithGrounding({ apiKey: keys.gemini_key, model, prompt: actualitePrompt(subject) });
      const title  = `Veille — ${subject} (${now})`;
      return {
        title,
        content: `# ${title}\n*Veille automatique · ${modeLabel} · ${now}*\n\n${result.text}`,
        kind:    'recherche',
      };
    } catch (err) {
      lastErr = err;
      if (err.isAuth) throw Object.assign(new Error('Clé Gemini invalide ou révoquée.'), { auth: true });
    }
  }
  throw lastErr ?? new Error('Grounding Google Search indisponible sur ton quota actuel.');
}

// ── Type registry ─────────────────────────────────────────────────────────────

export const AGENT_TYPES = {
  veille: {
    label:       'Veille automatique',
    description: 'Lance une recherche sur un sujet et crée un neurone résumé.',
    paramsSchema: [
      { key: 'subject', label: 'Sujet de veille', type: 'text', required: true, placeholder: 'ex : Intelligence artificielle et éducation' },
      { key: 'mode',    label: 'Mode',            type: 'select', options: [
        { value: 'fond',      label: 'Synthèse de fond (connaissance IA)' },
        { value: 'actualite', label: 'Actualité web (Google Search)' },
      ], default: 'fond' },
    ],
    execute: ({ params, logger }) => runVeille(params, { logger }),
  },
};

// ── Single agent execution ────────────────────────────────────────────────────

export async function executeAgent(agent, { triggeredBy = 'manual', logger } = {}) {
  const type = AGENT_TYPES[agent.type];
  if (!type) throw new Error(`Type d'agent inconnu : ${agent.type}`);

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  insertAgentRun({ id: runId, agent_id: agent.id, started_at: startedAt, triggered_by: triggeredBy });

  let output;
  try {
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Timeout : l\'agent a dépassé 5 minutes.')), AGENT_TIMEOUT_MS),
    );
    output = await Promise.race([
      type.execute({ params: agent.params, logger }),
      timeoutPromise,
    ]);
  } catch (err) {
    updateAgentRun(runId, {
      finished_at:   new Date().toISOString(),
      status:        'error',
      error_message: err.message ?? String(err),
    });
    logger?.warn({ agentId: agent.id, type: agent.type, err: err.message, triggeredBy }, 'agent run failed');
    throw err;
  }

  updateAgentRun(runId, {
    finished_at:  new Date().toISOString(),
    status:       'success',
    output_title: output.title,
  });

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

  logger?.info({ agentId: agent.id, type: agent.type, title: output.title, triggeredBy }, 'agent run success');
  return { runId, output };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let schedulerTimer = null;

export function startAgentScheduler({ logger } = {}) {
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
        await executeAgent(agent, { triggeredBy: 'schedule', logger });
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
