import { chatCompletion } from './ollama.js';
import { completeWithCascade as geminiCascade, setGeminiRpm } from './providers/gemini.js';
import * as groqProvider       from './providers/groq.js';
import * as openrouterProvider from './providers/openrouter.js';
import * as anthropicProvider  from './providers/anthropic.js';
import * as openaiProvider     from './providers/openai.js';
import * as freellmapiProvider from './providers/freellmapi.js';
import { getCloudKeys, getRouterSettings } from './sqlite.js';
import { isInCooldown, recordSuccess, recordFailure, getAllProviderStatuses } from './provider-state.js';
export { clearCooldown as clearProviderCooldown } from './provider-state.js';

// Import des nouveaux providers
import { pairProvider } from './providers/pair.js';
import { claudeOAuthProvider } from './providers/claude-oauth.js';
import { codexProvider } from './providers/codex.js';

// Helper pour logger le routage — trace non sensible de chaque décision réelle
// de routage (aucune clé/token, uniquement provider/modèle/action/auth_mode).
// `feature` identifie la fonctionnalité Docteur d'origine (capture, rag,
// deep_capture, etc.) pour l'audit de propagation demandé — voir chaque
// appelant de routedCompletion()/tryCloudFallbackChain() dans server.js.
const PROVIDER_AUTH_MODE = {
  'claude-oauth': 'cli_session', // affiné dynamiquement si besoin par l'appelant
  codex:          'cli_session',
  anthropic:      'api_key',
  openai:         'api_key',
  gemini:         'api_key',
  groq:           'api_key',
  openrouter:     'api_key',
  freellmapi:     'api_key',
  pair:           'none',
  local:          'none',
};

function logRoute(action, provider, model, logger, { fallback = false, feature = null, authMode = null, taskType = null, durationMs = null } = {}) {
  logger?.info({
    action,
    feature: feature ?? action,
    task_type: taskType ?? action,
    router: 'legacy',
    provider,
    auth_mode: authMode ?? PROVIDER_AUTH_MODE[provider] ?? 'unknown',
    model,
    fallback,
    ...(durationMs == null ? {} : { duration_ms: durationMs }),
  }, 'AI_ROUTE');
}

export const CLOUD_PROVIDER_IDS = ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'freellmapi', 'claude-oauth', 'codex'];

export function getCloudProviderStatuses() {
  return getAllProviderStatuses(CLOUD_PROVIDER_IDS);
}

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
// Each entry: { providerId, level, paid, call(messages) → { text, model, quotaModels? } }

async function cloudCandidates(keys, settings, logger, preferredModel = null) {
  const candidates = [];

  // L4 free providers (priority order)
  if (keys.gemini_key) {
    candidates.push({
      providerId: 'gemini',
      level: 4,
      paid: false,
      call: (messages) => geminiCascade({ apiKey: keys.gemini_key, messages, logger }),
    });
  }
  if (keys.groq_key) {
    candidates.push({
      providerId: 'groq',
      level: 4,
      paid: false,
      call: (messages) => groqProvider.complete({ apiKey: keys.groq_key, messages, model: preferredModel ?? settings?.groq_model }),
    });
  }
  if (keys.openrouter_key) {
    candidates.push({
      providerId: 'openrouter',
      level: 4,
      paid: false,
      call: (messages) => openrouterProvider.complete({ apiKey: keys.openrouter_key, messages }),
    });
  }
  const freeConfig = settings?.freellmapi;
  if (freeConfig?.enabled && keys.freellmapi_key && freeConfig.baseUrl) {
    let freeModels = [];
    try { freeModels = await freellmapiProvider.listModels({ ...freeConfig, apiKey: keys.freellmapi_key }); } catch { /* health route reports the error */ }
    const freeOnly = freeConfig.freeOnly === true;
    const hasVerifiedFreeModel = freeModels.some(model => model.free === true);
    const paidGatewayAllowed = settings?.paying_apis_enabled === true;
    if (hasVerifiedFreeModel || (!freeOnly && paidGatewayAllowed)) {
      candidates.push({
        providerId: 'freellmapi',
        level: 4,
        paid: !hasVerifiedFreeModel,
        allowFallback: freeConfig.allowFallback !== false,
        call: (messages) => freellmapiProvider.complete({
          config: { ...freeConfig, apiKey: keys.freellmapi_key },
          model: freeConfig.mode === 'manual' ? freeConfig.textModel : 'auto',
          messages,
        }),
      });
    }
  }

  // ── Claude: exactly one of subscription (claude-oauth/CLI) or API key ──────
  // Mutually exclusive by design — never both, no ambiguity, no accidental
  // API billing when the user picked "Claude Code / abonnement". Subscription
  // mode carries no per-token cost to Docteur, so it is NOT gated behind
  // paying_apis_enabled (that toggle exists specifically to gate *paid API*
  // usage) — only the API-key mode is.
  const claudeMode = settings?.claude_mode ?? 'subscription';
  if (claudeMode === 'subscription') {
    try {
      const claudeConfigured = await claudeOAuthProvider.isConfigured();
      if (claudeConfigured) {
        candidates.push({
          providerId: 'claude-oauth',
          level: 5,
          paid: false, // subscription — no per-call API cost to Docteur
          call: (messages) => claudeOAuthProvider.generate({ messages }),
        });
      }
    } catch {
      // Ignorer si erreur
    }
  } else if (claudeMode === 'api' && settings?.paying_apis_enabled && keys.anthropic_key) {
    candidates.push({
      providerId: 'anthropic',
      level: 5,
      paid: true,
      call: (messages) => anthropicProvider.complete({ apiKey: keys.anthropic_key, messages }),
    });
  }

  // ── OpenAI: exactly one of subscription (Codex/CLI) or API key ────────────
  const openaiMode = settings?.openai_mode ?? 'subscription';
  if (openaiMode === 'subscription') {
    try {
      const codexConfigured = await codexProvider.isConfigured();
      if (codexConfigured) {
        candidates.push({
          providerId: 'codex',
          level: 5,
          paid: false, // subscription — no per-call API cost to Docteur
          call: (messages) => codexProvider.generate({ messages }),
        });
      }
    } catch {
      // Ignorer si erreur
    }
  } else if (openaiMode === 'api' && settings?.paying_apis_enabled && keys.openai_key) {
    candidates.push({
      providerId: 'openai',
      level: 5,
      paid: true,
      call: (messages) => openaiProvider.complete({ apiKey: keys.openai_key, messages }),
    });
  }

  // Skip any provider currently in cooldown (rate limited, quota exhausted,
  // auth failed, or offline) — retried automatically once the cooldown
  // expires, or immediately after a manual "Retester maintenant".
  return candidates.filter(c => {
    if (isInCooldown(c.providerId)) {
      logger?.info({ provider: c.providerId }, 'Provider en cooldown, ignoré pour cette requête');
      return false;
    }
    return true;
  });
}

// Wraps a candidate's call() to record success/failure into provider-state,
// so the next request's cloudCandidates() filter reflects the outcome.
function withStateTracking(candidate) {
  return {
    ...candidate,
    call: async (messages) => {
      try {
        const result = await candidate.call(messages);
        recordSuccess(candidate.providerId);
        return result;
      } catch (err) {
        recordFailure(candidate.providerId, err);
        throw err;
      }
    },
  };
}

const TASK_CAPABILITIES = {
  local:     new Set(['text', 'json', 'structured_output', 'fast', 'cheap', 'local']),
  pair:      new Set(['text', 'json', 'structured_output', 'fast', 'cheap', 'local']),
  gemini:    new Set(['text', 'json', 'structured_output', 'vision', 'long_context', 'tools', 'fast', 'cheap']),
  groq:      new Set(['text', 'json', 'structured_output', 'fast', 'cheap']),
  openrouter:new Set(['text', 'json', 'structured_output', 'long_context', 'tools']),
  anthropic: new Set(['text', 'json', 'structured_output', 'vision', 'long_context', 'tools']),
  openai:    new Set(['text', 'json', 'structured_output', 'vision', 'long_context', 'tools']),
  freellmapi: new Set(['text', 'json', 'structured_output']),
  'claude-oauth': new Set(['text', 'json', 'structured_output', 'vision', 'long_context', 'tools']),
  codex:     new Set(['text', 'json', 'structured_output', 'long_context', 'tools']),
};

function supportsCapabilities(provider, requiredCapabilities = []) {
  const capabilities = TASK_CAPABILITIES[provider] ?? new Set();
  return requiredCapabilities.every(capability => capabilities.has(capability));
}

function localTaskModel(settings, preferredModel, installedNames = []) {
  if (preferredModel && preferredModel !== 'local') return preferredModel;
  return findModelForLevel(3, installedNames)
    ?? settings?.fallback_model
    ?? 'llama3.2:3b';
}

function makeLocalTaskCandidate({ settings, preferredModel, requiredCapabilities, installedNames, client, messages }) {
  if (!supportsCapabilities('local', requiredCapabilities)) return null;
  const model = localTaskModel(settings, preferredModel, installedNames);
  return { providerId: 'local', model, paid: false, call: () => chatCompletion(client, model, messages) };
}

async function buildTaskCandidates({ keys, settings, preferredProvider, preferredModel, requiredCapabilities, allowCloud, allowPaid, client, messages, installedNames, logger }) {
  const localPreferredModel = preferredProvider === 'local' ? preferredModel : null;
  const local = makeLocalTaskCandidate({ settings, preferredModel: localPreferredModel, requiredCapabilities, installedNames, client, messages });
  const candidates = local ? [local] : [];
  if (!allowCloud || settings?.strict_local_mode === true || settings?.cloud_enabled === false) return candidates;

  const cloud = (await cloudCandidates(keys, settings, logger, preferredModel))
    .filter(candidate => allowPaid || !candidate.paid)
    .filter(candidate => supportsCapabilities(candidate.providerId, requiredCapabilities));
  const preferred = preferredProvider && preferredProvider !== 'local'
    ? cloud.filter(candidate => candidate.providerId === preferredProvider)
    : [];
  const remaining = cloud.filter(candidate => !preferredProvider || candidate.providerId !== preferredProvider);
  if (preferredProvider && preferredProvider !== 'local') return [...preferred, ...remaining, ...candidates];
  return [...candidates, ...preferred, ...remaining];
}

// Shared task-level facade for feature modules that need explicit provider or
// model selection while retaining the existing router policy and providers.
export async function runAiTask({
  feature,
  taskType,
  messages,
  preferredProvider = null,
  preferredModel = null,
  requiredCapabilities = ['text'],
  allowCloud = true,
  allowPaid = true,
  responseFormat = 'text',
  client,
  installedNames = [],
  settings = getRouterSettings(),
  logger,
} = {}) {
  const startedAt = Date.now();
  const strictLocal = settings?.strict_local_mode === true;
  const cloudAllowed = allowCloud && !strictLocal && settings?.cloud_enabled !== false;
  const keys = getCloudKeys();
  const candidates = await buildTaskCandidates({
    keys, settings, preferredProvider, preferredModel, requiredCapabilities,
    allowCloud: cloudAllowed, allowPaid, client, messages, installedNames, logger,
  });
  if (candidates.length === 0) {
    throw new Error(`Aucun provider compatible pour ${feature ?? 'cette tâche'} (${requiredCapabilities.join(', ')})`);
  }

  let lastError;
  for (const [index, candidate] of candidates.entries()) {
    const fallback = index > 0 || (!!preferredProvider && candidate.providerId !== preferredProvider);
    try {
      const result = await withStateTracking(candidate).call(messages);
      const text = typeof result === 'string' ? result : result.text;
      const model = typeof result === 'string' ? candidate.model : (result.model ?? candidate.model ?? candidate.providerId);
      logRoute(taskType ?? feature ?? 'ai_task', candidate.providerId, model, logger, {
        fallback,
        feature,
        taskType,
        durationMs: Date.now() - startedAt,
      });
      return { text, response: text, provider: candidate.providerId, model, responseFormat, fallback };
    } catch (error) {
      lastError = error;
      logger?.warn({ feature, task_type: taskType, provider: candidate.providerId, error: error.message }, 'AI_TASK_PROVIDER_FAILED');
      if (candidate.allowFallback === false) break;
    }
  }

  throw lastError ?? new Error(`Tous les providers ont échoué pour ${feature ?? 'cette tâche'}`);
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

// ── Shared cloud fallback chain (Groq → Gemini → OpenRouter → paid) ───────────
// Used directly by features that only need a single free-form cloud completion
// (clarify.js, pdf.js intro generation, agent-runner.js veille) without the
// full local/cloud level-routing that routedCompletion() does for RAG/chat.
// Consolidates what used to be four independent copies of this same chain.
//
// Returns { text, provider, model } on success, or null if no provider is
// configured / all providers failed / strict_local_mode blocks cloud entirely.
export async function tryCloudFallbackChain(messages, { logger, settingsOverride } = {}) {
  const keys     = getCloudKeys();
  const settings = settingsOverride ?? getRouterSettings();

  if (settings?.strict_local_mode === true) return null;

  const candidates = (await cloudCandidates(keys, settings, logger)).map(withStateTracking);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    try {
      const result = await candidate.call(messages);
      return { text: result.text, provider: candidate.providerId, model: result.model ?? candidate.providerId };
    } catch (err) {
      logger?.warn({ provider: candidate.providerId, error: err.category ?? 'UNKNOWN', message: err.message }, 'Cloud provider failed, trying next');
      if (candidate.allowFallback === false) break;
    }
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
        logRoute(action, 'local', model, logger);
        return { response, model, level, provider: 'local', quotaHit: false, routingReason: 'mode local strict' };
      } catch { /* try lower level */ }
    }
    // Ultimate fallback: use whatever model is configured
    const fallbackModel = settings?.fallback_model ?? 'llama3.2:3b';
    const response = await chatCompletion(client, fallbackModel, messages);
    logRoute(action, 'local', fallbackModel, logger, { fallback: true });
    return { response, model: fallbackModel, level: 0, provider: 'local', quotaHit: false, routingReason: 'mode local strict' };
  }

  if (!routerEnabled) {
    const model = settings?.fallback_model ?? 'llama3.2:3b';
    const response = await chatCompletion(client, model, messages);
    logRoute(action, 'local', model, logger);
    return { response, model, level: 0, provider: 'local', quotaHit: false, routingReason: 'router désactivé' };
  }

  const inputText = String(input ?? '').toLowerCase();
  const rawLevel  = ACTION_LEVEL_MAP[action] ?? calculateLevel(inputText, context);
  const wordCount = context.word_count ?? 0;

  const keys         = getCloudKeys();
  const cloudEnabled = settings?.cloud_enabled !== false;
  const hasCandidates = (await cloudCandidates(keys, settings, logger)).length > 0;
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
    const candidates      = (await cloudCandidates(keys, settings, logger)).map(withStateTracking);
    const levelCandidates = candidates.filter(c => c.level <= targetLevel);
    let anyQuotaHit = false;

    for (const candidate of levelCandidates) {
      try {
        const result  = await candidate.call(messages);
        const quotaHit = (result.quotaModels?.length ?? 0) > 0;
        logRoute(action, candidate.providerId, result.model ?? candidate.providerId, logger);
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
          logger?.warn({ provider: candidate.providerId, category: err.category, error: err.message }, 'quota épuisé, essai provider suivant');
        } else {
          logger?.warn({ provider: candidate.providerId, category: err.category ?? 'UNKNOWN', error: err.message }, 'Cloud provider failed, trying next');
        }
        if (candidate.allowFallback === false) break;
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
        logRoute(action, 'local', model, logger, { fallback: true });
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

  // Essayer PAIR en premier (priorité 1 pour les providers locaux)
  let pairAttempted = false;
  try {
    const pairConfigured = await pairProvider.isConfigured();
    if (pairConfigured) {
      logger?.info({ endpoint: pairProvider.endpoint }, 'PAIR_ATTEMPT');
      pairAttempted = true;
      const pairHealth = await pairProvider.getHealth();
      if (pairHealth.status === 'connected') {
        const result = await pairProvider.generate({ messages });
        logRoute(action, 'pair', result.model ?? 'pair', logger);
        return {
          response: result.text,
          model: result.model ?? 'pair',
          level: 1,
          provider: 'pair',
          quotaHit: false,
          routingReason: localReason,
        };
      }
      logger?.warn({ reason: pairHealth.error }, 'PAIR_FAILED');
    }
  } catch (err) {
    errors.push(`pair: ${err.message}`);
    if (pairAttempted) logger?.warn({ reason: err.message }, 'PAIR_FAILED');
  }
  if (pairAttempted) logger?.info({ provider: 'ollama' }, 'FALLBACK');

  for (let level = targetLevel; level >= 1; level--) {
    const model = findModelForLevel(level, installedNames ?? []);
    if (!model) continue;

    try {
      const response = await chatCompletion(client, model, messages);
      logRoute(action, 'local', model, logger, { fallback: pairAttempted });
      if (pairAttempted) logger?.info({ model }, 'OLLAMA_SUCCESS');
      return { response, model, level, provider: 'local', quotaHit: false, routingReason: localReason };
    } catch (err) {
      errors.push(`niveau ${level} (${model}): ${err.message}`);
    }
  }

  const detail = errors.length ? ` Détails: ${errors.join('; ')}` : '';
  throw new Error(`Tous les modèles ont échoué.${detail}`);
}
