import { chatCompletion } from './ollama.js';
import { completeWithCascade as geminiCascade, setGeminiRpm } from './providers/gemini.js';
import * as groqProvider       from './providers/groq.js';
import * as openrouterProvider from './providers/openrouter.js';
import * as anthropicProvider  from './providers/anthropic.js';
import * as openaiProvider     from './providers/openai.js';
import { getCloudKeys } from './sqlite.js';

// ── Level → candidate models (ordered by preference) ─────────────────────────
const LEVEL_CANDIDATES = {
  1: ['llama3.2:3b', 'llama3.2:1b', 'phi3:mini', 'phi3.5:mini'],
  2: ['qwen2.5:7b',  'llama3.1:8b', 'mistral:7b', 'llama3.2:3b'],
  // qwen2.5:14b excluded from auto-routing — too large for 8 GB VRAM (causes
  // 40-55s load + inference). Use qwen2.5:7b which fits in VRAM and responds
  // in 10-20s. 14b can still be used via manual override in settings.
  3: ['qwen2.5:7b',  'llama3.1:8b', 'mistral:7b', 'llama3.2:3b'],
};

export const LEVEL_LABELS = {
  1: 'TRIVIAL — léger local',
  2: 'STANDARD — moyen local',
  3: 'PUISSANT — lourd local',
  4: 'CLOUD GRATUIT — Gemini / OpenRouter',
  5: 'CLOUD PAYANT — Claude / GPT-4o',
};

// ── Action → target level ────────────────────────────────────────────────────
// deep_capture uses level 2 (qwen2.5:7b) — fits entirely in 8 Go VRAM and
// avoids the constant load/unload cycle caused by 14b during batch captures.
const ACTION_LEVEL_MAP = {
  capture_title_gen:  1,
  auto_tag:           1,
  rag_simple:         2,
  rag_complex:        2,  // stays on 7b — 14b causes 40-55s load on 8 GB VRAM
  summarize_long:     3,
  compare_neurons:    3,
  deep_capture:       2,
  deep_synthesis:     4,
  web_research:       4,
  learning_explain:   4,
};

// Word count threshold above which deep_capture is escalated to L4 if a cloud
// key is configured, rather than truncating and staying local.
const CLOUD_WORD_THRESHOLD = 6_000;

// ── Complexity keywords (French + English) ────────────────────────────────────
const COMPLEX_WORDS = [
  'analyse', 'analyser', 'comparer', 'compare', 'synthese', 'synthèse',
  'synthétiser', 'evaluation', 'évaluation', 'evaluer', 'évaluer',
  'profond', 'détaillé', 'detaille', 'complet', 'exhaustif',
  'recherche', 'veille', 'expert', 'approfondi', 'complexe',
];

// Explicit phrases that always justify cloud, regardless of preference.
// Order matters: longer/more specific first.
const STRONG_COMPLEX_PHRASES = [
  'analyse approfondie', 'analyse exhaustive', 'analyse détaillée', 'analyse complète',
  'synthèse exhaustive', 'synthèse complète', 'compare en détail',
  'comparaison détaillée', 'étude approfondie', 'deep analysis', 'in-depth',
];

// ── Module-level quota guard ──────────────────────────────────────────────────
// After all Gemini models return 429, we skip cloud for 30 min so we don't
// waste retries and cause unnecessary latency.
let _quotaExhaustedUntil = 0;
function markQuotaExhausted()    { _quotaExhaustedUntil = Date.now() + 30 * 60 * 1000; }
function quotaCurrentlyExhausted() { return Date.now() < _quotaExhaustedUntil; }

// ── Heuristic level for unknown actions ───────────────────────────────────────
function calculateLevel(input, context = {}) {
  let score = 0;
  const text = String(input ?? '').toLowerCase();

  if (text.length > 200)  score += 1;
  if (text.length > 800)  score += 1;

  score += COMPLEX_WORDS.filter(w => text.includes(w)).length;

  const n = context.neurons_count ?? 0;
  if (n > 10) score += 1;
  if (n > 50) score += 1;

  if (score <= 1) return 2;
  if (score <= 3) return 3;
  return 4; // very complex → try cloud
}

// ── Match an installed model name against a candidate ─────────────────────────
function isModelInstalled(candidate, installedNames) {
  const [base, tag] = candidate.split(':');
  return installedNames.some(name => {
    if (name === candidate) return true;
    if (name.startsWith(`${base}:`) && (!tag || name.includes(tag))) return true;
    if (name.startsWith(`${base}@`)) return true;
    return false;
  });
}

function findModelForLevel(level, installedNames) {
  for (const candidate of (LEVEL_CANDIDATES[level] ?? [])) {
    if (isModelInstalled(candidate, installedNames)) {
      const [base, tag] = candidate.split(':');
      const actual = installedNames.find(name =>
        name === candidate ||
        (name.startsWith(`${base}:`) && (!tag || name.includes(tag))) ||
        name.startsWith(`${base}@`)
      );
      return actual ?? null;
    }
  }
  return null;
}

// ── Public: all candidate models across levels (no duplicates) ────────────────
export function getAllCandidateModels() {
  const seen = new Set();
  const result = [];
  for (const level of [1, 2, 3]) {
    for (const model of LEVEL_CANDIDATES[level]) {
      if (!seen.has(model)) {
        seen.add(model);
        result.push({ model, level });
      }
    }
  }
  return result;
}

export function getModelStatuses(installedNames) {
  return getAllCandidateModels().map(({ model, level }) => ({
    model,
    level,
    level_label: LEVEL_LABELS[level],
    installed: isModelInstalled(model, installedNames),
    install_cmd: `ollama pull ${model}`,
  }));
}

// ── Cloud provider ordered by priority ────────────────────────────────────────
// Each entry: { providerId, level, call(messages) → { text, model, quotaModels? } }

function cloudCandidates(keys, settings, logger) {
  const candidates = [];

  // L4 free providers (priority order)
  if (keys.gemini_key) {
    candidates.push({
      providerId: 'gemini',
      level: 4,
      call: (messages) => geminiCascade({ apiKey: keys.gemini_key, messages, logger }),
    });
  }
  if (keys.groq_key) {
    candidates.push({
      providerId: 'groq',
      level: 4,
      call: (messages) => groqProvider.complete({ apiKey: keys.groq_key, messages, model: settings?.groq_model }),
    });
  }
  if (keys.openrouter_key) {
    candidates.push({
      providerId: 'openrouter',
      level: 4,
      call: (messages) => openrouterProvider.complete({ apiKey: keys.openrouter_key, messages }),
    });
  }

  // L5 paying providers (only if enabled)
  if (settings?.paying_apis_enabled) {
    if (keys.anthropic_key) {
      candidates.push({
        providerId: 'anthropic',
        level: 5,
        call: (messages) => anthropicProvider.complete({ apiKey: keys.anthropic_key, messages }),
      });
    }
    if (keys.openai_key) {
      candidates.push({
        providerId: 'openai',
        level: 5,
        call: (messages) => openaiProvider.complete({ apiKey: keys.openai_key, messages }),
      });
    }
  }

  return candidates;
}

// ── Cloud escalation decision for RAG actions ─────────────────────────────────
// Returns the reason string if we should escalate, null if we should stay local.
function shouldEscalateRag(action, inputText, context, preference, quotaBlocked) {
  if (quotaBlocked) return null; // quota guard overrides everything

  const totalChars = context.total_chars ?? 0;
  const hasStrong  = STRONG_COMPLEX_PHRASES.some(p => inputText.includes(p));

  // Thresholds per preference level (characters of retrieved neurone content)
  const charThreshold = preference === 'quality' ? 8_000 : preference === 'balanced' ? 15_000 : 25_000;

  if (hasStrong) return 'analyse complexe';
  if (totalChars > charThreshold) return 'contenu long';
  if (preference === 'quality'  && action === 'rag_complex') return 'préférence qualité';
  if (preference === 'balanced' && action === 'rag_complex') {
    const hasAny = COMPLEX_WORDS.some(w => inputText.includes(w));
    if (hasAny) return 'analyse complexe';
  }
  return null;
}

// ── Core: routed completion with automatic fallback ───────────────────────────
// Returns { response, model, level, provider, quotaHit, routingReason, warning? }
export async function routedCompletion(client, { action, input, context = {}, messages, installedNames, settings, logger }) {
  const routerEnabled = settings?.router_enabled !== false;
  const preference    = settings?.cloud_preference ?? 'local'; // 'local' | 'balanced' | 'quality'

  // Apply Gemini RPM setting to the rate limiter (reads from persisted settings)
  setGeminiRpm(settings?.gemini_rpm ?? 10);

  // ── VERROU GLOBAL : mode strictement local ────────────────────────────────
  // When strict_local_mode is ON, cloud is NEVER reached, regardless of any
  // other setting (preference, cloud_enabled, keys configured, etc.).
  // This path is INFRANCHISSABLE — no fallback or escalation can bypass it.
  if (settings?.strict_local_mode === true) {
    const inputText = String(input ?? '').toLowerCase();
    const rawLevel  = ACTION_LEVEL_MAP[action] ?? calculateLevel(inputText, context);
    const capLevel  = Math.min(rawLevel, 3);
    for (let level = capLevel; level >= 1; level--) {
      const model = findModelForLevel(level, installedNames ?? []);
      if (!model) continue;
      try {
        const response = await chatCompletion(client, model, messages);
        return { response, model, level, provider: 'local', quotaHit: false, routingReason: 'mode local strict' };
      } catch { /* try lower level */ }
    }
    // Ultimate fallback: use whatever model is configured
    const fallbackModel = settings?.fallback_model ?? 'llama3.2:3b';
    const response = await chatCompletion(client, fallbackModel, messages);
    return { response, model: fallbackModel, level: 0, provider: 'local', quotaHit: false, routingReason: 'mode local strict' };
  }

  if (!routerEnabled) {
    const model = settings?.fallback_model ?? 'llama3.2:3b';
    const response = await chatCompletion(client, model, messages);
    return { response, model, level: 0, provider: 'local', quotaHit: false, routingReason: 'router désactivé' };
  }

  const inputText = String(input ?? '').toLowerCase();
  const rawLevel  = ACTION_LEVEL_MAP[action] ?? calculateLevel(inputText, context);
  const wordCount = context.word_count ?? 0;

  const keys         = getCloudKeys();
  const cloudEnabled = settings?.cloud_enabled !== false;
  const hasCandidates = cloudCandidates(keys, settings, logger).length > 0;
  const quotaBlocked  = quotaCurrentlyExhausted();

  let targetLevel   = rawLevel;
  let routingReason = null; // will be set before returning

  // ── Escalate deep_capture on very long content ────────────────────────────
  if (action === 'deep_capture' && wordCount > CLOUD_WORD_THRESHOLD) {
    if (cloudEnabled && hasCandidates && !quotaBlocked) {
      targetLevel   = 4;
      routingReason = 'contenu long';
    }
  }

  // ── Escalate RAG based on preference and content signals ─────────────────
  if ((action === 'rag_simple' || action === 'rag_complex') && targetLevel < 4) {
    if (cloudEnabled && hasCandidates) {
      const reason = shouldEscalateRag(action, inputText, context, preference, quotaBlocked);
      if (reason) {
        targetLevel   = 4;
        routingReason = reason;
      }
    }
  }

  // If target is cloud but quota blocked → stay local with explicit reason
  if (targetLevel >= 4 && quotaBlocked) {
    targetLevel   = 3;
    routingReason = 'quota épuisé → local';
  }

  // If target is cloud but no keys/cloud disabled → cap at local
  if (targetLevel >= 4 && (!cloudEnabled || !hasCandidates)) {
    targetLevel   = Math.min(rawLevel, 3);
    routingReason = null;
  }

  // ── Cloud path (L4-5) ─────────────────────────────────────────────────────
  if (targetLevel >= 4) {
    const candidates      = cloudCandidates(keys, settings, logger);
    const levelCandidates = candidates.filter(c => c.level <= targetLevel);
    let anyQuotaHit = false;

    for (const candidate of levelCandidates) {
      try {
        const result  = await candidate.call(messages);
        const quotaHit = (result.quotaModels?.length ?? 0) > 0;
        return {
          response:      result.text,
          model:         result.model ?? candidate.providerId,
          level:         candidate.level,
          provider:      candidate.providerId,
          quotaHit,
          routingReason: routingReason ?? candidate.providerId,
        };
      } catch (err) {
        if (err.isQuota) {
          anyQuotaHit = true;
          logger?.warn({ provider: candidate.providerId, error: err.message }, 'quota épuisé, essai provider suivant');
        } else {
          logger?.warn({ provider: candidate.providerId, error: err.message }, 'Cloud provider failed, trying next');
        }
      }
    }

    // All cloud providers failed → mark quota and fall back to local
    if (anyQuotaHit) markQuotaExhausted();
    const warning = anyQuotaHit
      ? 'Limite Gemini atteinte — bascule automatique sur le modèle local. Réessai dans quelques minutes.'
      : 'Tous les providers cloud ont échoué — bascule sur le modèle local.';
    logger?.warn({ action, targetLevel }, warning);

    const localErrors = [];
    for (let level = 3; level >= 1; level--) {
      const model = findModelForLevel(level, installedNames ?? []);
      if (!model) continue;
      try {
        const response = await chatCompletion(client, model, messages);
        return {
          response,
          model,
          level,
          provider:      'local',
          quotaHit:      anyQuotaHit,
          routingReason: anyQuotaHit ? 'quota épuisé → local' : 'cloud échoué → local',
          warning,
        };
      } catch (err) {
        localErrors.push(`niveau ${level} (${model}): ${err.message}`);
      }
    }
    const detail = localErrors.length ? ` Détails: ${localErrors.join('; ')}` : '';
    throw new Error(`Tous les modèles ont échoué.${detail}`);
  }

  // ── Local path (L1-3) ────────────────────────────────────────────────────
  const localReason = quotaBlocked ? 'quota épuisé → local' : (routingReason ?? 'local suffisant');
  const errors = [];

  for (let level = targetLevel; level >= 1; level--) {
    const model = findModelForLevel(level, installedNames ?? []);
    if (!model) continue;

    try {
      const response = await chatCompletion(client, model, messages);
      return { response, model, level, provider: 'local', quotaHit: false, routingReason: localReason };
    } catch (err) {
      errors.push(`niveau ${level} (${model}): ${err.message}`);
    }
  }

  const detail = errors.length ? ` Détails: ${errors.join('; ')}` : '';
  throw new Error(`Tous les modèles ont échoué.${detail}`);
}
