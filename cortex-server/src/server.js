import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import { createLogger } from './lib/logger.js';
import { checkPortOwnership } from './lib/port-preflight.js';
import { createOllamaClient, embedText, chatCompletion, chatCompletionPowerful, unloadModel, getInstalledModels, verifyModelAvailability } from './lib/ollama.js';
import { countNeurons, deleteNeuron as deleteNeuronFromIndex, getAllNeurons, getAllNeuronsForBackup, getFragmentStats, getTableStatus, needsCompaction, optimizeTable, searchNeurons, upsertNeuron } from './lib/lancedb.js';
import { initSqlite, logRequest, logRouterCall, getRouterSettings, setMeta, getMeta, getCloudKeys, getPageFromStore, logWhisperCall, getWhisperStats, insertActivityLog, getActivityLogRetentionDays, purgeActivityLogOlderThan, getRequestLogRetentionDays, purgeRequestLogsOlderThan, getStyleExampleSettings } from './lib/sqlite.js';
import { findStyleExamples, buildStyleExamplesBlock, describeUsedExamples } from './lib/style-examples.js';
import { routedCompletion } from './lib/router.js';
import { loadPairEndpointFromStorage } from './lib/providers/pair.js';
import { completeWithCascade as geminiCascade } from './lib/providers/gemini.js';
import * as groqProvider       from './lib/providers/groq.js';
import * as openrouterProvider from './lib/providers/openrouter.js';
import { createHealthRoute } from './routes/health.js';
import { createJobsRoute } from './routes/jobs.js';
import { createIndexRoute } from './routes/index.js';
import { createCaptureRoute } from './routes/capture.js';
import { createSearchRoute } from './routes/search.js';
import { createAnswerRoute } from './routes/answer.js';
import { createNeuronRoute } from './routes/neuron.js';
import { createBackupRoute } from './routes/backup.js';
import { createCorpusRoute } from './routes/corpus.js';
import { createActivityRoute } from './routes/activity.js';
import { createRouterRoute } from './routes/router.js';
import { createFreeAiRoute } from './routes/free-ai.js';
import { createOllamaRoute } from './routes/ollama.js';
import { createLocalAiRoute } from './routes/local-ai.js';
import { createDownloadRoute } from './routes/download.js';
import { createResearchRoute } from './routes/research.js';
import { createStyleExamplesRoute } from './routes/style-examples.js';
import { createImageRoute } from './routes/image.js';
import { createImageGenerationRoute } from './routes/image-generation.js';
import { createVisionRoute } from './routes/vision.js';
import { createChatRoute } from './routes/chat.js';
import { ensureImageDir } from './lib/image.js';
import { createFilesRoute } from './routes/files.js';
import { createClarifyRoute } from './routes/clarify.js';
import { createPdfRoute }       from './routes/pdf.js';
import { createCandidatureRoute } from './routes/candidature.js';
import { createCvImportRoute }    from './routes/cv-import.js';
import { createAgentsRoute }      from './routes/agents.js';
import { createExternalAgentsRoute } from './routes/external-agents.js';
import { ExternalAgents } from './lib/external-agents.js';
import { createVideoSummaryRoute } from './routes/video-summary.js';
import { createOpenMontageRoute } from './routes/openmontage.js';
import { createMetaGptRoute } from './routes/metagpt.js';
import { createCyberAuditRoute } from './routes/cyber-audit.js';
import { createMonitorRoute } from './routes/monitor.js';
import { createMaitreRoute } from './routes/maitre.js';
import { startMonitorServiceIfAutostart } from './lib/monitor-service.js';
import { startAgentScheduler }    from './lib/agent-runner.js';
import { createInboxRoute }       from './routes/inbox.js';
import { startInboxWatcher }      from './lib/inbox-watcher.js';
import { buildPersonaPrompt, buildPersonaToneNote, getPersonaSettings } from './lib/persona.js';
import { markPrivate }             from './lib/privacy-guard.js';
import { isLocalOnlySource }       from './lib/source-privacy.js';
import { getMemorySettings, isWorthRemembering, addEpisodicMemoryDeduped, privacyFromSource } from './lib/memory.js';
import { createPrivacyRoute }      from './routes/privacy.js';
import { createConnectorsRoute }   from './routes/connectors.js';
import { createMemoryRoute }       from './routes/memory.js';
import { createNotebookRoute }     from './routes/notebook.js';
import { createNotebookLmRoute }   from './routes/notebooklm.js';
import { createBrowserRoute }      from './routes/browser.js';
import { createSherlockRoute }     from './routes/sherlock.js';
import { createCodeIntelRoute }    from './routes/code-intel.js';
import { createInvestmentRoute }   from './routes/investment.js';
import { createSalesRoute }        from './routes/sales.js';
import { shutdownSherlock } from './lib/sherlock.js';
import { createSecretScanRoute }   from './routes/secret-scan.js';
import { createVoiceRoute }        from './routes/voice.js';
import { createCompareRoute }      from './routes/compare.js';
import { createWebAnswerRoute }    from './routes/web-answer.js';
import { createWebExploreRoute }   from './routes/web-explore.js';
import { createSkillsRoute }       from './routes/skills.js';
import { createPromptGeneratorRoute } from './routes/prompt-generator.js';
import { createTeacherRoute }       from './routes/teacher.js';
import { createTodoRoute }         from './routes/todo.js';
import { createKiwixRoute }        from './routes/kiwix.js';
import { createAudioPlayerRoute }  from './routes/audio-player.js';
import { createOmegaRoute }        from './routes/omega.js';
import { createOmegaViewRoute }    from './routes/omega-view.js';
import { createOmegaInteractiveRoute } from './routes/omega-interactive.js';
import { createOmegaAdminRoute }   from './routes/omega-admin.js';
import { registerShutdownHook as registerKiwixShutdownHook, stopKiwixServe } from './lib/kiwix.js';
import { getKiwixSearchScope } from './lib/sqlite.js';
import { search as kiwixSearch, getContent as kiwixGetContent } from './lib/kiwix-client.js';
import { sanitizeZimHtml } from './lib/kiwix-sanitize.js';
import { wrapUntrustedZimContent } from './lib/kiwix-policy.js';
import { checkYtDlp } from './lib/ytdlp.js';
import { scheduleDailyBackup } from './lib/backup.js';
import { buildCaptureResult } from './lib/capture.js';
import { extractContent } from './lib/deep-capture.js';
import { transcribeYouTube, ensureTmpDir, cleanTmpDir, TMP_DIR, downloadAudio } from './lib/whisper.js';
import { transcribeWithGroq } from './lib/whisper-groq.js';
import { assertSafeUrl } from './lib/url-security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

// ── Local-network mode (off by default) ──────────────────────────────────────
// Set LOCAL_NETWORK=true in .env to expose on the LAN (Wi-Fi / mobile access).
// NEVER set this on a machine directly reachable from the internet.
const LOCAL_NETWORK = process.env.LOCAL_NETWORK === 'true';

// Detect the machine's LAN IP (first non-loopback IPv4 address)
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of (ifaces[name] ?? [])) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}
const LOCAL_IP = LOCAL_NETWORK ? getLocalIp() : null;

// HTTPS cert for LOCAL_NETWORK mode (generated by scripts/gen-cert.mjs).
// In localhost dev mode we stay on HTTP — no cert needed.
const CERT_DIR = path.resolve(rootDir, '..', 'certs');
const CERT_KEY = path.join(CERT_DIR, 'key.pem');
const CERT_PEM = path.join(CERT_DIR, 'cert.pem');
const USE_HTTPS = LOCAL_NETWORK && fs.existsSync(CERT_KEY) && fs.existsSync(CERT_PEM);
if (LOCAL_NETWORK && !USE_HTTPS) {
  throw new Error(`LOCAL_NETWORK=true requires TLS certificate files at ${CERT_KEY} and ${CERT_PEM}; refusing cleartext LAN startup`);
}
let TLS_CERTIFICATE_FINGERPRINT = null;
if (USE_HTTPS) {
  try {
    // Public certificate metadata only. The private key is never returned,
    // logged or included in any API response.
    TLS_CERTIFICATE_FINGERPRINT = new crypto.X509Certificate(fs.readFileSync(CERT_PEM)).fingerprint256;
  } catch (error) {
    throw new Error(`TLS certificate invalid: ${error.message}`);
  }
}

const env = {
  PORT: Number(process.env.PORT ?? 3001),
  HOST: LOCAL_NETWORK ? '0.0.0.0' : (process.env.HOST ?? '127.0.0.1'),
  OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
  ANSWER_MODEL: process.env.ANSWER_MODEL ?? 'llama3.2:3b',
  LANCEDB_PATH: path.resolve(rootDir, process.env.LANCEDB_PATH ?? './data/cortex.lance'),
  SQLITE_PATH: path.resolve(rootDir, process.env.SQLITE_PATH ?? './data/cortex.sqlite'),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  LOG_FILE: path.resolve(rootDir, process.env.LOG_FILE ?? './data/cortex.log')
};

fs.mkdirSync(path.dirname(env.LANCEDB_PATH), { recursive: true });
fs.mkdirSync(path.dirname(env.SQLITE_PATH), { recursive: true });
fs.mkdirSync(path.dirname(env.LOG_FILE), { recursive: true });
ensureTmpDir();
cleanTmpDir(); // remove leftover audio files from previous run
ensureImageDir();

const logger = createLogger({ level: env.LOG_LEVEL, logFile: env.LOG_FILE });

// ── Global crash safety net ───────────────────────────────────────────────────
// Route handlers and background jobs (corpus import, inbox watcher, agent
// scheduler) already catch their own errors, but any promise rejection that
// slips past all of those would otherwise crash the whole process silently.
// unhandledRejection: log with the full stack and keep running — an isolated
// async failure somewhere shouldn't take down neurons, RAG, and everything
// else along with it.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err: err.message, stack: err.stack }, 'unhandled promise rejection — process kept alive');
});

// uncaughtException: Node's own state may be inconsistent past this point, so
// exiting is the safer choice — but always with a clear, loud trace first so
// it's never a silent/mysterious crash.
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaught exception — process terminating');
  process.exit(1);
});

initSqlite(env.SQLITE_PATH);
setMeta('boot_at', new Date().toISOString());

// Reload PAIR endpoint from persisted settings (survives restart) before any
// request can reach the router — see lib/providers/pair.js for priority order.
loadPairEndpointFromStorage(getMeta, logger);

// Purge activity log entries past the retention window (default 90 days) on every boot.
{
  const retentionDays = getActivityLogRetentionDays();
  const purged = purgeActivityLogOlderThan(retentionDays);
  if (purged > 0) logger.info({ purged, retentionDays }, 'activity log: old entries purged');
}

// Purge request_logs entries past the retention window (default 30 days) on
// every boot, in small bounded batches — see purgeRequestLogsOlderThan for
// why this table needs batching where activity_log doesn't.
{
  const retentionDays = getRequestLogRetentionDays();
  const purged = purgeRequestLogsOlderThan(retentionDays);
  if (purged > 0) logger.info({ purged, retentionDays }, 'request logs: old entries purged');
}

const ollamaClient = createOllamaClient(env.OLLAMA_URL);
const startedAt = Date.now();

// ── Installed-model cache (30s TTL) to avoid double Ollama round trips ────────
let _modelCache = null;
let _modelCacheAt = 0;

function invalidateInstalledModelCache() {
  _modelCache = null;
  _modelCacheAt = 0;
}

// ── Powerful-model mutex — prevent concurrent qwen2.5:14b inferences ─────────
// 14b barely fits on 8 GB VRAM; two parallel calls would OOM.
let _powerfulBusy = false;
async function getCachedInstalledModelNames() {
  const now = Date.now();
  if (_modelCache && now - _modelCacheAt < 30_000) return _modelCache;
  try {
    const models = await getInstalledModels(ollamaClient);
    _modelCache = models.map(m => m.name);
    _modelCacheAt = now;
    return _modelCache;
  } catch {
    return _modelCache ?? [];
  }
}

function sanitizePayloadSize(payload) {
  if (payload == null) {
    return 0;
  }

  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return 0;
  }
}

function isOllamaError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return message.includes('ollama') || message.includes('fetch') || message.includes('connect') || message.includes('econnrefused') || message.includes('socket hang up') || message.includes('503');
}

async function ollamaHealth() {
  try {
    const models = await getInstalledModels(ollamaClient);
    const embeddingAvailable = await verifyModelAvailability(ollamaClient, env.EMBEDDING_MODEL);
    const answerAvailable = await verifyModelAvailability(ollamaClient, env.ANSWER_MODEL);
    return {
      connected: true,
      models,
      embeddingAvailable,
      answerAvailable
    };
  } catch (error) {
    return {
      connected: false,
      models: [],
      embeddingAvailable: false,
      answerAvailable: false,
      error: error.message
    };
  }
}

async function healthSnapshot() {
  const ollama = await ollamaHealth();
  const lancedb = await getTableStatus(env.LANCEDB_PATH);
  const neuronsCount = await countNeurons(env.LANCEDB_PATH);
  const modelsAvailable = [];

  const installedNames = new Set(ollama.models.map((model) => model.name));

  if (ollama.embeddingAvailable) {
    modelsAvailable.push(ollama.models.find((model) => installedNames.has(model.name) && (model.name === env.EMBEDDING_MODEL || model.name.startsWith(`${env.EMBEDDING_MODEL}:`) || model.name.startsWith(`${env.EMBEDDING_MODEL}@`)) )?.name ?? env.EMBEDDING_MODEL);
  }

  if (ollama.answerAvailable) {
    modelsAvailable.push(ollama.models.find((model) => installedNames.has(model.name) && (model.name === env.ANSWER_MODEL || model.name.startsWith(`${env.ANSWER_MODEL}:`) || model.name.startsWith(`${env.ANSWER_MODEL}@`)) )?.name ?? env.ANSWER_MODEL);
  }

  return {
    status: ollama.connected ? 'ok' : 'degraded',
    ollama_connected: ollama.connected,
    models_available: modelsAvailable,
    neurons_count: neuronsCount,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    local_network: LOCAL_NETWORK,
    local_ip: LOCAL_IP ?? null,
    tls_enabled: USE_HTTPS,
    tls_certificate_fingerprint: TLS_CERTIFICATE_FINGERPRINT,
    // Static markers (not probes) so a client can tell an old, pre-MAITRE
    // Cortex instance apart from the current build without guessing from
    // uptime/PID: absent on any server build that predates this field.
    maitre_routes: true,
    pid: process.pid,
  };
}

async function ensureOllamaAvailableOrThrow() {
  const health = await ollamaHealth();
  if (!health.connected) {
    const error = new Error('Ollama est indisponible. Verifie que le service tourne sur le port configure.');
    error.code = 'OLLAMA_DOWN';
    throw error;
  }

  return health;
}

// nomic-embed-text context window is 2048 tokens (~8 192 chars).
// Truncate to keep well within limits; title is always preserved in full.
const MAX_EMBED_CHARS = 7_500;

async function indexNeuron(payload) {
  await ensureOllamaAvailableOrThrow();
  const raw        = `${payload.title}\n\n${payload.content}`;
  const embedInput = raw.length > MAX_EMBED_CHARS ? raw.slice(0, MAX_EMBED_CHARS) : raw;

  const t0 = performance.now();
  const embedding  = await embedText(ollamaClient, env.EMBEDDING_MODEL, embedInput);
  const embedding_ms = Math.round(performance.now() - t0);

  const t1 = performance.now();
  await upsertNeuron(env.LANCEDB_PATH, {
    ...payload,
    metadata: payload.metadata ?? {},
    vector: embedding
  });
  const lancedb_ms = Math.round(performance.now() - t1);

  // Local, rule-based "learn from neurons" (Phase 3 adaptive memory) — never
  // an AI call, never cloud. Scoped to manually created neurons only (not
  // bulk imports like corpus/connector, which would flood episodic memory
  // with hundreds of unrelated titles per sync) — kind is the same signal
  // server.js already uses to decide privacy auto-detection just below.
  const BULK_IMPORT_KINDS = new Set(['corpus', 'connector']);
  try {
    const memorySettings = getMemorySettings();
    if (memorySettings.enabled && memorySettings.learn_from_neurons && !BULK_IMPORT_KINDS.has(payload.kind) && isWorthRemembering(payload.title)) {
      addEpisodicMemoryDeduped({
        text: String(payload.title).slice(0, 300), category: 'neuron_interest', source: 'neuron_created', sourceRef: payload.id,
        ...privacyFromSource({ kind: payload.kind, isPrivatePage: payload.private, metadata: payload.metadata }), importance: 0.4, confidence: 0.4,
      });
    }
  } catch { /* best-effort — must never break neuron indexing */ }

  return {
    ok: true,
    dimensions: embedding.length,
    embedding_ms,
    lancedb_ms,
    latency_ms: embedding_ms + lancedb_ms,
  };
}

// Case-insensitive + accent-insensitive normalisation
// "Café" → "cafe", "WIFI" → "wifi", "élève" → "eleve"
function normalize(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Keyword score for a single neuron vs query — case & accent insensitive
// Returns 0 if no match, 0.68–0.95 otherwise
function keywordScore(title, content, query) {
  const tNorm = normalize(title);
  const cNorm = normalize(content);
  const q     = normalize(query);
  if (!q) return 0;

  // Full-phrase match — highest priority
  if (tNorm.includes(q)) return 0.95;
  if (cNorm.includes(q)) return 0.85;

  // Individual word match (words >= 3 chars to skip noise like "le", "la", "en")
  const words = q.split(/\s+/).filter(w => w.length >= 3);
  if (words.length === 0) return 0;

  const inTitle   = words.some(w => tNorm.includes(w));
  const inContent = words.some(w => cNorm.includes(w));
  if (inTitle)   return 0.78;
  if (inContent) return 0.68;

  return 0;
}

async function searchNeuronsEndpoint(payload) {
  await ensureOllamaAvailableOrThrow();

  const query        = String(payload.query ?? '');
  const limit        = Number(payload.limit ?? 5);
  const threshold    = Number(payload.threshold ?? 0.2);  // combined final threshold
  const filterByKinds = Array.isArray(payload.filter_by_kind) ? payload.filter_by_kind : [];

  // ── 1. Semantic search (low threshold to get broad candidates) ────────────
  const vector    = await embedText(ollamaClient, env.EMBEDDING_MODEL, query);
  const semantic  = await searchNeurons(env.LANCEDB_PATH, vector, {
    limit:        Math.max(limit * 3, 20),  // fetch more candidates than needed
    threshold:    0.1,                       // very permissive; final filter applied below
    filterByKinds,
  });

  // ── 2. Keyword search (full scan, O(n) over all neurons) ─────────────────
  const allNeurons = await getAllNeurons(env.LANCEDB_PATH);
  const keyword    = allNeurons
    .filter(n => filterByKinds.length === 0 || filterByKinds.includes(n.kind))
    .map(n => {
      const kScore = keywordScore(n.title, n.content, query);
      if (kScore === 0) return null;
      return { id: n.id, title: n.title, kind: n.kind, content_preview: n.content_preview, metadata: n.metadata, score: kScore };
    })
    .filter(Boolean);

  // ── 3. Merge: per-neuron keep the highest score ───────────────────────────
  const merged = new Map();

  for (const r of semantic) {
    merged.set(r.id, { id: r.id, title: r.title, kind: r.kind, content_preview: r.content_preview, metadata: r.metadata, score: r.score });
  }
  for (const r of keyword) {
    if (merged.has(r.id)) {
      merged.get(r.id).score = Math.max(merged.get(r.id).score, r.score);
    } else {
      merged.set(r.id, r);
    }
  }

  // ── 4. Final filter, sort, slice ──────────────────────────────────────────
  const final = [...merged.values()]
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Same auto-private detection as answerQuestion (server.js ~535-550):
  // cv/candidature kinds are always private, plus any page explicitly marked
  // private:true by the user. Callers that build cloud-bound prompts from
  // this endpoint's results (teacher.js, style-examples.js) must exclude or
  // otherwise guard on this flag — it was previously not exposed here at all.
  const AUTO_PRIVATE_KINDS = new Set(['cv', 'candidature']);
  const isPrivate = (r) => {
    if (isLocalOnlySource(r)) return true;
    try { return isLocalOnlySource(getPageFromStore(r.id)); } catch { return false; }
  };

  return {
    results: final.map(r => ({
      id:              r.id,
      title:           r.title,
      kind:            r.kind,
      content_preview: r.content_preview ?? '',
      metadata:        r.metadata ?? {},
      score:           Number(r.score.toFixed(4)),
      private:         isPrivate(r),
    })),
    count:      final.length,
    latency_ms: 0,
  };
}

function buildSystemPrompt() {
  const persona = buildPersonaPrompt(getPersonaSettings());
  return `${persona}

Tu réponds en t'appuyant uniquement sur les neurones fournis. Si l'information n'est pas présente, dis-le clairement sans inventer.`;
}

function buildContextMessages(question, sources, clarificationContext = []) {
  const context = sources
    .map((source, index) => {
      const origin = source.isKiwix ? 'ARCHIVE ZIM (Kiwix)' : (source.kind === 'corpus' ? 'RÉFÉRENCE (corpus externe)' : 'NEURONE PERSONNEL');
      return `Source ${index + 1} [${origin}]\nTitre: ${source.title}\nType: ${source.kind}\nContenu: ${source.content}`;
    })
    .join('\n\n');

  const msgs = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'system', content: `Neurones disponibles:\n\n${context}\n\nQuand tu t'appuies sur une source marquée RÉFÉRENCE, précise que l'information vient du corpus de référence (cite son titre) et distingue-la de ce qui vient des neurones personnels. Quand tu t'appuies sur une source marquée ARCHIVE ZIM (Kiwix), précise clairement que l'information vient d'une archive locale hors-ligne (cite le titre de l'article) et distingue-la des neurones personnels.` },
  ];

  if (clarificationContext.length > 0) {
    const ctx = clarificationContext
      .map(({ question: q, answer: a }) => `- ${q} → ${a}`)
      .join('\n');
    msgs.push({ role: 'system', content: `Contexte personnel fourni par l'utilisateur :\n${ctx}\n\nTiens compte de ce contexte pour personnaliser ta réponse.` });
  }

  msgs.push({ role: 'user', content: question });
  return msgs;
}

function extractFallbackAnswer(sources) {
  for (const source of sources) {
    // rawContent (clean extracted text) when present — e.g. Kiwix sources,
    // whose `content` field carries the untrusted-data prompt wrapper and
    // would otherwise make this regex match the wrapper's own framing text.
    const content = String(source.rawContent ?? source.content ?? '');
    const match = content.match(/(?:est|=|:|est\s+le|est\s+la)\s+([A-Za-z0-9._\-@#]+)/i);
    if (match?.[1]) {
      return { value: match[1], title: source.title };
    }
  }

  const firstSource = sources[0];
  if (!firstSource) {
    return null;
  }

  const compact = String(firstSource.rawContent ?? firstSource.content ?? '').replace(/\s+/g, ' ').trim();
  return {
    value: compact.length > 0 ? compact : 'information disponible dans le neurone',
    title: firstSource.title
  };
}

// Resolves the "mode puissant" model to actually call: the configured
// powerful_model (Settings, default qwen2.5:14b-instruct-q3_K_M) if it's
// installed, else any installed variant sharing its base name (handles a
// stale exact-tag mismatch), else whatever qwen2.5:14b variant is installed
// (covers switching from the quantized default back to the full model), else
// the configured name as a last resort (chatCompletionPowerful will then
// surface Ollama's own "model not found" error).
function resolvePowerfulModel(installedNames, routerSettings) {
  const configured = routerSettings?.powerful_model ?? 'qwen2.5:14b-instruct-q3_K_M';
  const base = configured.split(':')[0] + ':' + (configured.split(':')[1] ?? '').split('-')[0]; // e.g. "qwen2.5:14b"
  return installedNames.find(n => n === configured)
    ?? installedNames.find(n => n.startsWith(configured))
    ?? installedNames.find(n => n.startsWith(base))
    ?? configured;
}

function shouldFallbackToExtraction(answer) {
  const normalized = String(answer ?? '').toLowerCase();
  return normalized.length === 0 || normalized.includes('je ne peux pas') || normalized.includes('je ne peux pas vous aider') || normalized.includes('i cannot') || normalized.includes('cannot help') || normalized.includes('je n\'ai pas') || normalized.includes('remarque');
}

async function answerQuestion(payload) {
  await ensureOllamaAvailableOrThrow();

  const vector = await embedText(ollamaClient, env.EMBEDDING_MODEL, payload.question);
  const maxContext = Number(payload.max_context ?? 5);
  // scope: 'all' (default) | 'personal' (exclude corpus references) | 'reference' (corpus only)
  const scope = payload.scope === 'personal' || payload.scope === 'reference' ? payload.scope : 'all';
  const fetchLimit = scope === 'personal' ? maxContext * 3 : maxContext; // over-fetch so post-filtering still fills maxContext
  let retrieved = await searchNeurons(env.LANCEDB_PATH, vector, {
    limit: fetchLimit,
    threshold: 0.35,
    filterByKinds: scope === 'reference' ? ['corpus'] : [],
  });
  if (scope === 'personal') {
    retrieved = retrieved.filter(item => item.kind !== 'corpus').slice(0, maxContext);
  }

  if (retrieved.length === 0) {
    return {
      answer: "Je n'ai rien trouve dans ton cortex sur ce sujet.",
      sources: [],
      no_results: true,
      model_used: null,
      router_level: null,
    };
  }

  const sources = retrieved.slice(0, maxContext).map((item) => ({
    id: item.id,
    title: item.title,
    score: Number(item.score.toFixed(4)),
    kind: item.kind,
    content: item.content,
    metadata: item.metadata,
  }));

  // ── Sources ZIM (Kiwix) additionnelles, selon le réglage "portée de recherche" ─
  // "mes neurones seuls" (défaut) | "archives seules" | "les deux". Jamais bulk :
  // uniquement les meilleurs résultats de recherche kiwix-serve pour la question.
  const kiwixScope = payload.kiwix_scope ?? getKiwixSearchScope();
  let kiwixSources = [];
  if (kiwixScope === 'archives' || kiwixScope === 'les_deux') {
    try {
      const results = await kiwixSearch('', payload.question, { pageLength: 3 });
      for (const r of results.slice(0, 3)) {
        try {
          const { html } = await kiwixGetContent(r.bookName, r.path);
          const cleaned = sanitizeZimHtml(html, r.bookName);
          const title = r.title || cleaned.title;
          // Kiwix ZIM content is data the Docteur team did not author (often
          // Wikipedia-derived, potentially containing vandalism or a crafted
          // prompt-injection payload) — wrap it the same way sales-policy.js/
          // investment-policy.js wrap externally-fetched web content before
          // it ever reaches an LLM prompt. `content` here is the wrapped
          // promptFragment (with the untrusted-data framing baked in), not
          // the raw article text.
          const wrapped = wrapUntrustedZimContent({
            book: r.bookName, articlePath: r.path, title,
            content: cleaned.text.slice(0, 4_000),
          });
          kiwixSources.push({
            id: `kiwix:${r.bookName}:${r.path}`,
            title,
            score: 0.5,
            kind: 'kiwix',
            // `content` feeds buildContextMessages (the LLM prompt) and must
            // carry the untrusted-data framing; `rawContent` is the clean
            // extracted text, kept separately so extractFallbackAnswer()'s
            // regex-based fallback still matches against real article text
            // instead of the wrapper's framing sentences.
            content: wrapped.promptFragment,
            rawContent: wrapped.content,
            isKiwix: true,
            untrusted: true,
            book: r.bookName,
            articlePath: r.path,
          });
        } catch { /* article isolé indisponible — on continue */ }
      }
    } catch (err) {
      logger.warn({ error: err.message }, 'kiwix search failed during answerQuestion');
    }
  }
  if (kiwixScope === 'archives') {
    sources.length = 0;
  }
  sources.push(...kiwixSources);

  if (sources.length === 0) {
    return {
      answer: "Je n'ai rien trouvé dans ton cortex ni dans les archives sur ce sujet.",
      sources: [],
      no_results: true,
      model_used: null,
      router_level: null,
    };
  }

  // ── Détection des sources privées ──────────────────────────────────────────
  // kinds auto-privés : cv et candidature (données personnelles)
  // pages marquées private:true par l'utilisateur
  const AUTO_PRIVATE_KINDS = new Set(['cv', 'candidature']);
  const hasPrivateSources = sources.some(s => {
    if (isLocalOnlySource(s)) return true;
    try { return isLocalOnlySource(getPageFromStore(s.id)); } catch { return false; }
  });

  // Belt-and-suspenders: tag private content with sentinel so provider-level
  // guard catches it even if routing logic has a bug.
  const taggedSources = sources.map(s => {
    const isPriv = isLocalOnlySource(s) ||
      (() => { try { return isLocalOnlySource(getPageFromStore(s.id)); } catch { return false; } })();
    return isPriv ? { ...s, content: markPrivate(s.content) } : s;
  });
  const messages = buildContextMessages(payload.question, taggedSources, payload.clarification_context ?? []);

  const installedNames = await getCachedInstalledModelNames();
  const routerSettings = getRouterSettings();

  const routingStarted = Date.now();
  const totalChars   = sources.reduce((sum, s) => sum + String(s.content ?? '').length, 0);

  let chosenModel    = env.ANSWER_MODEL;
  let chosenLevel    = 0;
  let chosenProvider = 'local';
  let chosenQuota    = false;
  let chosenWarning  = null;
  let chosenReason   = null;
  let rawAnswer      = '';
  let routingError   = null;

  // ── Force local si des sources privées sont présentes ────────────────────────
  // Les neurones cv, candidature et les pages marquées private ne doivent
  // JAMAIS être envoyés à un provider cloud, même partiellement.
  if (hasPrivateSources) {
    try {
      rawAnswer      = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
      chosenModel    = env.ANSWER_MODEL;
      chosenLevel    = 0;
      chosenProvider = 'local';
      chosenReason   = 'privé · neurones sensibles → local imposé';
    } catch (err) {
      throw new Error(`Réponse locale impossible : ${err.message}`);
    }
  }

  // ── Force-local-powerful mode: bypass router entirely, never touch cloud ──────
  else if (payload.force_local_powerful) {
    const actualModel = resolvePowerfulModel(installedNames, routerSettings);

    // Serialise concurrent 14b calls — two parallel inferences OOM on 8 GB VRAM
    if (_powerfulBusy) {
      const waitStart = Date.now();
      while (_powerfulBusy && Date.now() - waitStart < 180_000) {
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    _powerfulBusy = true;
    try {
      // Unload the 7b model first so 14b can claim the full VRAM budget
      await unloadModel(ollamaClient, 'qwen2.5:7b');

      // keep_alive=0 so 14b is evicted from VRAM after the call, freeing the 7b slot
      rawAnswer      = await chatCompletionPowerful(ollamaClient, actualModel, messages);
      chosenModel    = actualModel;
      chosenLevel    = 3;
      chosenProvider = 'local';
      chosenReason   = 'privé · 100% local';
    } catch (err) {
      logger.warn({ model: actualModel, error: err.message }, '14b failed, fallback to 7b');
      routingError   = err.message;
      chosenWarning  = 'Le modèle puissant n\'a pas pu répondre — bascule automatique sur qwen2.5:7b.';
      try {
        rawAnswer    = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
        chosenModel  = env.ANSWER_MODEL;
        chosenLevel  = 0;
        chosenReason = 'fallback 7b (14b indisponible)';
      } catch (err2) {
        throw new Error(`14b et 7b ont échoué : ${err2.message}`);
      }
    } finally {
      // Powerful model evicts nomic-embed-text from VRAM. Re-warm it now so the next indexNeuron
      // call doesn't hit a 27s cold-load spike.
      embedText(ollamaClient, env.EMBEDDING_MODEL, 'warmup').catch(() => {});
      _powerfulBusy = false;
    }
  } else {
  // ── Normal routing ─────────────────────────────────────────────────────────
  const complexWords = ['analyse', 'compare', 'comparer', 'synthese', 'synthèse', 'résume', 'detail', 'détail', 'approfondi'];
  const isComplex = complexWords.some(w => payload.question.toLowerCase().includes(w)) || sources.length >= 4;
  const routerAction = isComplex ? 'rag_complex' : 'rag_simple';

  try {
    const result = await routedCompletion(ollamaClient, {
      action: routerAction,
      input: payload.question,
      context: { neurons_count: sources.length, total_chars: totalChars },
      messages,
      installedNames,
      settings: routerSettings,
      logger,
    });
    rawAnswer      = result.response;
    chosenModel    = result.model;
    chosenLevel    = result.level;
    chosenProvider = result.provider ?? 'local';
    chosenQuota    = result.quotaHit ?? false;
    chosenWarning  = result.warning ?? null;
    chosenReason   = result.routingReason ?? null;
  } catch (err) {
    routingError = err.message;
    rawAnswer    = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
    chosenModel  = env.ANSWER_MODEL;
    chosenLevel  = 0;
  }
  } // end normal routing

  const routingLatency = Date.now() - routingStarted;

  logRouterCall({
    actionType:     payload.force_local_powerful ? 'rag_local_powerful' : (payload.question.toLowerCase().split(/\s+/).some(w => ['analyse','compare','comparer','synthese','synthèse','résume','detail','détail','approfondi'].includes(w)) ? 'rag_complex' : 'rag_simple'),
    chosenLevel,
    chosenModel,
    inputLength:    payload.question.length,
    responseLength: rawAnswer.length,
    latencyMs:      routingLatency,
    success:        !routingError,
    errorMessage:   routingError,
    provider:       chosenProvider,
    quotaHit:       chosenQuota,
  });

  const fallback = extractFallbackAnswer(sources);
  const finalAnswer = shouldFallbackToExtraction(rawAnswer) && fallback
    ? `D'apres ${fallback.title}, la reponse est ${fallback.value}.`
    : rawAnswer.trim();

  return {
    answer: finalAnswer,
    sources: sources.map(({ id, title, score, kind, isKiwix, book, articlePath }) => ({
      id, title, score, kind, isKiwix: isKiwix || undefined, book, articlePath,
    })),
    latency_ms: 0,
    model_used: chosenModel,
    router_level: chosenLevel,
    routing_reason: chosenReason ?? undefined,
    warning: chosenWarning ?? undefined,
    has_private_sources: hasPrivateSources || undefined,
  };
}

// Only providers callOneModel() actually implements below. anthropic/openai
// were previously listed here but had no implementation branch — requesting
// them would fall through to "Provider inconnu", and the compare UI
// (CompareModal.tsx) never offers them as choices in the first place. Not a
// security issue (paying_apis_enabled was never bypassed, since the call
// would just throw), but misleading; removed rather than adding a new paid
// code path here.
// Only providers callOneModel() actually implements below. anthropic/openai
// were previously listed here but had no implementation branch — requesting
// them would fall through to "Provider inconnu", and the compare UI
// (CompareModal.tsx) never offers them as choices in the first place. Not a
// security issue (paying_apis_enabled was never bypassed, since the call
// would just throw), but misleading; removed rather than adding a new paid
// code path here.
const CLOUD_COMPARE_IDS = new Set(['gemini', 'groq', 'openrouter']);
const MAX_COMPARE_MODELS = 5;

async function compareModels({ question, models, max_context, onEvent }) {
  await ensureOllamaAvailableOrThrow();

  // Deduplicate + cap
  const modelList = [...new Set(models)].slice(0, MAX_COMPARE_MODELS);

  // Search once for all models
  const vector = await embedText(ollamaClient, env.EMBEDDING_MODEL, question);
  const maxCtx = Math.min(Number(max_context ?? 5), 10);
  const retrieved = await searchNeurons(env.LANCEDB_PATH, vector, { limit: maxCtx, threshold: 0.35 });

  // Privacy check
  const AUTO_PRIVATE_KINDS = new Set(['cv', 'candidature']);
  const hasPrivateSources = retrieved.some(s => {
    if (isLocalOnlySource(s)) return true;
    try { return isLocalOnlySource(getPageFromStore(s.id)); } catch { return false; }
  });

  const sources = retrieved.slice(0, maxCtx).map(item => ({
    id: item.id, title: item.title, score: Number(item.score.toFixed(4)), kind: item.kind, content: item.content, metadata: item.metadata,
  }));

  const taggedSources = sources.map(s => {
    const isPriv = isLocalOnlySource(s) ||
      (() => { try { return isLocalOnlySource(getPageFromStore(s.id)); } catch { return false; } })();
    return isPriv ? { ...s, content: markPrivate(s.content) } : s;
  });

  const messages = buildContextMessages(question, taggedSources, []);
  const cleanSources = sources.map(({ id, title, score }) => ({ id, title, score }));
  const routerSettings = getRouterSettings();
  const strictLocal = routerSettings?.strict_local_mode === true;
  const keys = getCloudKeys();

  await onEvent({ type: 'ready', has_private_sources: hasPrivateSources, sources_count: sources.length });

  async function callOneModel(modelId) {
    const started = Date.now();

    if (CLOUD_COMPARE_IDS.has(modelId)) {
      if (hasPrivateSources) throw new Error('neurones privés — cloud désactivé');
      if (strictLocal) throw new Error('mode strictement local actif');

      if (modelId === 'gemini') {
        if (!keys.gemini_key) throw new Error('clé Gemini non configurée');
        const result = await geminiCascade({ apiKey: keys.gemini_key, messages, logger });
        return { answer: result.text, model_used: result.model ?? 'gemini', provider: 'gemini', latency_ms: Date.now() - started };
      }
      if (modelId === 'groq') {
        if (!keys.groq_key) throw new Error('clé Groq non configurée');
        const result = await groqProvider.complete({ apiKey: keys.groq_key, messages, model: routerSettings?.groq_model });
        return { answer: result.text, model_used: result.model ?? 'groq', provider: 'groq', latency_ms: Date.now() - started };
      }
      if (modelId === 'openrouter') {
        if (!keys.openrouter_key) throw new Error('clé OpenRouter non configurée');
        const result = await openrouterProvider.complete({ apiKey: keys.openrouter_key, messages });
        return { answer: result.text, model_used: result.model ?? 'openrouter', provider: 'openrouter', latency_ms: Date.now() - started };
      }
      throw new Error(`Provider inconnu : ${modelId}`);
    }

    // Local Ollama model
    const text = await chatCompletion(ollamaClient, modelId, messages);
    return { answer: text, model_used: modelId, provider: 'local', latency_ms: Date.now() - started };
  }

  const localModels = modelList.filter(m => !CLOUD_COMPARE_IDS.has(m));
  const cloudModels = modelList.filter(m => CLOUD_COMPARE_IDS.has(m));

  // Local models: sequential (8 GB VRAM — no concurrent inference)
  async function runLocal() {
    for (const modelId of localModels) {
      await onEvent({ type: 'progress', model_id: modelId, status: 'running' });
      try {
        const r = await callOneModel(modelId);
        await onEvent({ type: 'result', model_id: modelId, ...r, sources: cleanSources });
      } catch (err) {
        await onEvent({ type: 'error', model_id: modelId, error: err.message });
      }
    }
  }

  // Cloud models: parallel (each call is independent HTTP)
  const cloudPromises = cloudModels.map(async (modelId) => {
    await onEvent({ type: 'progress', model_id: modelId, status: 'running' });
    try {
      const r = await callOneModel(modelId);
      await onEvent({ type: 'result', model_id: modelId, ...r, sources: cleanSources });
    } catch (err) {
      await onEvent({ type: 'error', model_id: modelId, error: err.message });
    }
  });

  await Promise.all([runLocal(), ...cloudPromises]);
  await onEvent({ type: 'done' });
}

async function generateNoteTitle(text) {
  const installedNames = await getCachedInstalledModelNames();
  const routerSettings = getRouterSettings();
  const messages = [
    { role: 'system', content: 'Tu es un assistant qui génère des titres courts et précis pour des notes. Réponds uniquement avec le titre, sans guillemets ni ponctuation finale. Maximum 8 mots.' },
    { role: 'user', content: `Génère un titre pour cette note :\n\n${text.slice(0, 600)}` },
  ];
  const result = await routedCompletion(ollamaClient, {
    action: 'capture_title_gen',
    input: text,
    context: {},
    messages,
    installedNames,
    settings: routerSettings,
    logger,
  });
  logRouterCall({
    actionType: 'capture_title_gen', chosenLevel: result.level, chosenModel: result.model,
    inputLength: text.length, responseLength: result.response.length, latencyMs: 0, success: true,
    provider: result.provider ?? 'local',
  });
  return result.response.trim();
}

async function captureInput(payload) {
  return buildCaptureResult(payload, { generateNoteTitle });
}

const DEEP_ANALYSIS_PROMPT = [
  'Analyse ce contenu et produis en français :',
  '1. RÉSUMÉ (3-5 phrases)',
  '2. POINTS CLÉS (5-8 puces)',
  '3. CHIFFRES ET FAITS NOTABLES',
  '4. À RETENIR (1-2 phrases).',
  '',
  'Markdown propre.',
].join('\n');

const RESUMMARISE_PROMPTS = {
  short: [
    'Résumé très court en français (2-3 phrases maximum) : l\'essentiel uniquement, sans détails ni liste.',
    'Markdown simple.',
  ].join('\n'),
  standard: DEEP_ANALYSIS_PROMPT,
  detailed: [
    'Analyse détaillée en français :',
    '1. RÉSUMÉ ÉTENDU (1-2 paragraphes complets)',
    '2. POINTS CLÉS développés (8-12 puces avec explication courte pour chacun)',
    '3. ARGUMENTS ET EXEMPLES importants mentionnés',
    '4. CHIFFRES, DATES ET FAITS NOTABLES',
    '5. À RETENIR (2-3 phrases)',
    '',
    'Markdown propre.',
  ].join('\n'),
  exhaustive: [
    'Compte-rendu exhaustif structuré en français (sections Markdown) :',
    '',
    '## Résumé',
    '## Points principaux',
    '(chaque point développé avec arguments, exemples, nuances)',
    '## Points secondaires',
    '## Chiffres, dates et faits notables',
    '## Conclusion',
    '',
    'Sois exhaustif. Markdown propre, sections complètes et détaillées.',
  ].join('\n'),
};

async function deepCapture(url) {
  await ensureOllamaAvailableOrThrow();

  // Step 1 — extract content
  const extraction = await extractContent(url);
  if (extraction.fallback) {
    if (extraction.needs_whisper) {
      return {
        fallback: true,
        needs_whisper: true,
        video_duration: extraction.video_duration ?? null,
        title: extraction.title ?? '',
        channel: extraction.channel ?? '',
      };
    }
    return { fallback: true, reason: extraction.reason ?? 'extraction_failed' };
  }

  // Step 2 — analyse via router
  const truncatedNote = extraction.truncated ? '\n\n⚠️ Contenu tronqué (source trop longue).' : '';
  const userContent   = `${DEEP_ANALYSIS_PROMPT}\n\nContenu :\n${extraction.text}${truncatedNote}`;
  const messages = [
    {
      role: 'system',
      content: 'Tu es un assistant d\'analyse de contenu. Produis une synthèse structurée en français avec du Markdown propre.',
    },
    { role: 'user', content: userContent },
  ];

  const installedNames  = await getCachedInstalledModelNames();
  const routerSettings  = getRouterSettings();

  let analysisResponse;
  let modelUsed;
  try {
    const result = await routedCompletion(ollamaClient, {
      action:       'deep_capture',
      input:        extraction.text,
      context:      { word_count: extraction.word_count },
      messages,
      installedNames,
      settings:     routerSettings,
      logger,
    });
    analysisResponse = result.response;
    modelUsed        = result.model;
    logRouterCall({
      actionType:     'deep_capture',
      chosenLevel:    result.level,
      chosenModel:    result.model,
      inputLength:    extraction.text.length,
      responseLength: result.response.length,
      latencyMs:      0,
      success:        true,
      provider:       result.provider ?? 'local',
      quotaHit:       result.quotaHit ?? false,
    });
  } catch (err) {
    logRouterCall({
      actionType: 'deep_capture', chosenLevel: 0, chosenModel: null,
      inputLength: extraction.text.length, responseLength: 0, latencyMs: 0,
      success: false, errorMessage: err.message, provider: null,
    });
    return { fallback: true, reason: 'analysis_failed', error: err.message };
  }

  // Step 3 — build parent/child using simple capture for the hierarchy
  const simpleResult = await buildCaptureResult(url, {}).catch(() => ({ parent: null, child: null }));

  const childKind  = extraction.source_type === 'youtube' ? 'video' : 'link';
  const childTitle = extraction.title || simpleResult.child?.title || 'Capture profonde';
  const fullContent = `${analysisResponse.trim()}\n\nSource : ${url}`;

  return {
    parent: simpleResult.parent ?? null,
    child: {
      title:    childTitle,
      kind:     childKind,
      content:  fullContent,
      metadata: {
        url,
        deep_capture: true,
        word_count:   extraction.word_count,
        model_used:   modelUsed,
        source_type:  extraction.source_type,
        truncated:    extraction.truncated ?? false,
        ...(extraction.imageUrls?.length > 0 ? { images: extraction.imageUrls } : {}),
      },
    },
    fallback:   false,
    model_used: modelUsed,
  };
}

const MAX_TEXT_WORDS = 8_000;

// Résout le bloc d'exemples de style à insérer dans un prompt de résumé, si
// le réglage global est activé — sinon comportement actuel inchangé (bloc vide).
async function resolveStyleExamplesBlock({ type, queryText } = {}) {
  const settings = getStyleExampleSettings();
  if (!settings.enabled) return { block: '', usedExamples: [] };
  const examples = await findStyleExamples(services, { type, queryText });
  return { block: buildStyleExamplesBlock(examples), usedExamples: describeUsedExamples(examples) };
}

async function deepCaptureText(text, source, url, styleExampleType) {
  await ensureOllamaAvailableOrThrow();

  // Truncate if needed (same logic as deep-capture.js)
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  let analysisText = text;
  let truncated = false;
  if (wordCount > MAX_TEXT_WORDS) {
    const half = Math.floor(MAX_TEXT_WORDS / 2);
    analysisText = words.slice(0, half).join(' ') + '\n\n[… contenu tronqué …]\n\n' + words.slice(-half).join(' ');
    truncated = true;
  }

  const { block: styleBlock, usedExamples } = await resolveStyleExamplesBlock({ type: styleExampleType, queryText: source });
  const truncatedNote = truncated ? '\n\n⚠️ Contenu tronqué (source trop longue).' : '';
  const userContent = `${DEEP_ANALYSIS_PROMPT}${styleBlock}\n\nContenu :\n${analysisText}${truncatedNote}`;
  const messages = [
    { role: 'system', content: `Tu es un assistant d'analyse de contenu. Produis une synthèse structurée en français avec du Markdown propre. ${buildPersonaToneNote(getPersonaSettings())}` },
    { role: 'user', content: userContent },
  ];

  const installedNames = await getCachedInstalledModelNames();
  const routerSettings = getRouterSettings();

  let analysisResponse, modelUsed;
  try {
    const result = await routedCompletion(ollamaClient, {
      action:       'deep_capture',
      input:        analysisText,
      context:      { word_count: wordCount },
      messages,
      installedNames,
      settings:     routerSettings,
      logger,
    });
    analysisResponse = result.response;
    modelUsed        = result.model;
    logRouterCall({
      actionType: 'deep_capture', chosenLevel: result.level, chosenModel: result.model,
      inputLength: analysisText.length, responseLength: result.response.length,
      latencyMs: 0, success: true, provider: result.provider ?? 'local',
      quotaHit: result.quotaHit ?? false,
    });
  } catch (err) {
    logRouterCall({
      actionType: 'deep_capture', chosenLevel: 0, chosenModel: null,
      inputLength: analysisText.length, responseLength: 0, latencyMs: 0,
      success: false, errorMessage: err.message, provider: null,
    });
    return { fallback: true, reason: 'analysis_failed', error: err.message };
  }

  const title = await generateNoteTitle(analysisText.slice(0, 1000)).catch(() => source);
  const fullContent = analysisResponse.trim() + (url ? `\n\nSource : ${url}` : '');

  return {
    parent: {
      title:    source,
      kind:     'channel',
      content:  source,
      metadata: { source },
    },
    child: {
      title,
      kind:     url ? 'link' : 'note',
      content:  fullContent,
      metadata: {
        source,
        deep_capture: true,
        pasted_text:  true,
        word_count:   wordCount,
        model_used:   modelUsed,
        truncated,
        ...(url ? { url } : {}),
        ...(usedExamples.length > 0 ? { style_examples_used: usedExamples } : {}),
      },
    },
    fallback:   false,
    model_used: modelUsed,
  };
}

async function deepCaptureWhisper(url, onProgress, signal, provider = 'local') {
  assertSafeUrl(url); // SSRF guard — rejects private IPs, localhost, etc.
  await ensureOllamaAvailableOrThrow();

  // Resolve 'auto': use Groq if key is configured and no quota hit in the last hour
  if (provider === 'auto') {
    const keys = getCloudKeys();
    if (keys.groq_key) {
      const stats = getWhisperStats();
      const lastQuota = stats.last_quota_at ? new Date(stats.last_quota_at) : null;
      const quotaRecent = lastQuota && (Date.now() - lastQuota.getTime() < 60 * 60 * 1000);
      provider = quotaRecent ? 'local' : 'groq';
    } else {
      provider = 'local';
    }
  }

  // strict_local_mode must be re-checked here, at the moment of the actual
  // cloud call — the caller may pass provider:'groq' explicitly regardless of
  // this setting, so re-checking it once at request start is not enough.
  if (provider === 'groq' && getRouterSettings()?.strict_local_mode === true) {
    provider = 'local';
  }

  // Step 1 — fetch video metadata
  let title = '';
  let channel = '';
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const data = await res.json();
      title   = String(data?.title       ?? '').trim();
      channel = String(data?.author_name ?? '').trim();
    }
  } catch { /* ignore */ }

  // Step 2 — transcribe (Groq or local)
  onProgress?.({ step: 'download', percent: 0, label: 'Téléchargement audio…' });
  let transcription;
  let transcriptionProvider = 'whisper_local';
  let groqFallbackInfo = null; // { reason, label } when Groq was requested but fell back to local

  if (provider === 'groq') {
    const keys = getCloudKeys();
    if (!keys.groq_key) {
      groqFallbackInfo = { reason: 'no_key', label: 'Clé Groq non configurée' };
      onProgress?.({ step: 'transcribe', percent: 0, label: '⚠️ Clé Groq manquante — bascule vers Whisper local…', groq_fallback: true, groq_fallback_reason: 'no_key' });
    } else {
      ensureTmpDir();
      const id = `wgroq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let audioPath = null;
      try {
        await downloadAudio(url, path.join(TMP_DIR, `${id}.%(ext)s`), { onProgress, signal });
        if (signal?.aborted) { const e = new Error('Annulé'); e.name = 'AbortError'; throw e; }
        const tmpFiles = await fs.promises.readdir(TMP_DIR);
        const found = tmpFiles.find(f => f.startsWith(id));
        audioPath = found ? path.join(TMP_DIR, found) : null;
        if (!audioPath) throw new Error('Audio introuvable après téléchargement');
        onProgress?.({ step: 'transcribe', percent: 5, label: 'Transcription via Groq Whisper…', provider: 'groq' });
        const groqResult = await transcribeWithGroq(audioPath, keys.groq_key);
        transcription = { text: groqResult.text, language: groqResult.language, duration_s: null };
        transcriptionProvider = 'whisper_groq';
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        let reason, label;
        if (err.isTooLarge) {
          reason = 'too_large';
          label  = '⚠️ Audio >100 MB — bascule vers Whisper local…';
        } else if (err.isQuota) {
          reason = 'quota';
          label  = '⚠️ Quota Groq atteint (429) — bascule vers Whisper local…';
        } else {
          reason = 'error';
          label  = `⚠️ Groq indisponible — bascule vers Whisper local…`;
        }
        logger?.warn({ reason, error_type: err.constructor?.name }, 'GROQ_WHISPER_FALLBACK');
        groqFallbackInfo = { reason, label };
        onProgress?.({ step: 'transcribe', percent: 0, label, groq_fallback: true, groq_fallback_reason: reason });
        // transcription remains null → falls through to local below
      } finally {
        try {
          const tmpFiles = await fs.promises.readdir(TMP_DIR);
          await Promise.all(
            tmpFiles
              .filter(f => f.startsWith(id))
              .map(f => fs.promises.unlink(path.join(TMP_DIR, f)).catch(() => {})),
          );
        } catch { /* ignore */ }
      }
    }
  }

  if (!transcription) {
    onProgress?.({ step: 'transcribe', percent: 0, label: 'Transcription Whisper local…', provider: 'local' });
    try {
      transcription = await transcribeYouTube(url, { onProgress, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return { fallback: true, reason: 'whisper_failed', error: err.message };
    }
  }

  // Log transcription call for stats
  logWhisperCall({
    provider: transcriptionProvider,
    durationS: transcription.duration_s ?? null,
    fallback: groqFallbackInfo !== null,
    fallbackReason: groqFallbackInfo?.reason ?? null,
  });

  const text = transcription.text ?? '';
  if (!text.trim()) {
    return { fallback: true, reason: 'whisper_empty' };
  }

  // Step 3 — analyse via router (Ollama only runs AFTER Whisper finishes)
  onProgress?.({ step: 'analyse', percent: 0, label: 'Analyse en cours…' });
  const words      = text.trim().split(/\s+/).filter(Boolean);
  const wordCount  = words.length;
  const MAX_WORDS  = 8_000;
  let analysisText = text;
  let truncated    = false;
  if (wordCount > MAX_WORDS) {
    const half = Math.floor(MAX_WORDS / 2);
    analysisText = words.slice(0, half).join(' ') + '\n\n[… contenu tronqué …]\n\n' + words.slice(-half).join(' ');
    truncated = true;
  }

  const truncatedNote = truncated ? '\n\n⚠️ Contenu tronqué (source trop longue).' : '';
  const userContent = `${DEEP_ANALYSIS_PROMPT}\n\nTranscription audio :\n${analysisText}${truncatedNote}`;
  const messages = [
    { role: 'system', content: `Tu es un assistant d'analyse de contenu. Produis une synthèse structurée en français avec du Markdown propre. ${buildPersonaToneNote(getPersonaSettings())}` },
    { role: 'user', content: userContent },
  ];

  const installedNames = await getCachedInstalledModelNames();
  const routerSettings = getRouterSettings();

  let analysisResponse, modelUsed;
  try {
    const result = await routedCompletion(ollamaClient, {
      action:       'deep_capture',
      input:        analysisText,
      context:      { word_count: wordCount },
      messages,
      installedNames,
      settings:     routerSettings,
      logger,
    });
    analysisResponse = result.response;
    modelUsed        = result.model;
    logRouterCall({
      actionType: 'deep_capture_whisper', chosenLevel: result.level, chosenModel: result.model,
      inputLength: analysisText.length, responseLength: result.response.length,
      latencyMs: 0, success: true, provider: result.provider ?? 'local', quotaHit: result.quotaHit ?? false,
    });
  } catch (err) {
    logRouterCall({
      actionType: 'deep_capture_whisper', chosenLevel: 0, chosenModel: null,
      inputLength: analysisText.length, responseLength: 0, latencyMs: 0,
      success: false, errorMessage: err.message, provider: null,
    });
    return { fallback: true, reason: 'analysis_failed', error: err.message };
  }

  const childTitle  = title || 'Transcription Whisper';
  const fullContent = `${analysisResponse.trim()}\n\nSource : ${url}`;

  return {
    parent: null,
    child: {
      title:    childTitle,
      kind:     'video',
      content:  fullContent,
      metadata: {
        url,
        deep_capture:  true,
        word_count:    wordCount,
        model_used:    modelUsed,
        source_type:   'youtube',
        transcription_provider: transcriptionProvider,
        channel,
        truncated,
        transcription_raw: text,
      },
    },
    fallback:       false,
    model_used:     modelUsed,
    groq_fallback:  groqFallbackInfo,
  };
}

async function resummariseTranscription({ transcription, level, focus, usePowerful, styleExampleType, onProgress }) {
  await ensureOllamaAvailableOrThrow();

  const { block: styleBlock, usedExamples } = await resolveStyleExamplesBlock({ type: styleExampleType });
  const basePrompt = RESUMMARISE_PROMPTS[level] ?? RESUMMARISE_PROMPTS.standard;
  const focusLine  = focus?.trim() ? `Focalise l'analyse sur : ${focus.trim()}\n\n` : '';
  const fullPrompt = focusLine + basePrompt + styleBlock;

  const words     = transcription.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const installedNames = await getCachedInstalledModelNames();
  const routerSettings = getRouterSettings();

  const powerfulModel = resolvePowerfulModel(installedNames, routerSettings);

  const sysMsg = {
    role:    'system',
    content: `Tu es un assistant d'analyse de contenu. Produis une synthèse structurée en français avec du Markdown propre. ${buildPersonaToneNote(getPersonaSettings())}`,
  };

  const runLLM = async (msgs, inputText) => {
    if (usePowerful) {
      const text = await chatCompletionPowerful(ollamaClient, powerfulModel, msgs);
      // Powerful model evicts nomic-embed-text from VRAM — re-warm before the index call that follows
      embedText(ollamaClient, env.EMBEDDING_MODEL, 'warmup').catch(() => {});
      return { response: text, model: powerfulModel };
    }
    return routedCompletion(ollamaClient, {
      action: 'deep_capture', input: inputText,
      context: { word_count: inputText.split(/\s+/).length },
      messages: msgs, installedNames, settings: routerSettings, logger,
    });
  };

  let analysisResponse, modelUsed;

  const CHUNK_WORDS = 5_500;
  if (level === 'exhaustive' && wordCount > CHUNK_WORDS) {
    // Chunked processing: summarise each section then synthesise
    const chunks = [];
    for (let i = 0; i < wordCount; i += CHUNK_WORDS) {
      chunks.push(words.slice(i, i + CHUNK_WORDS).join(' '));
    }
    const totalSteps     = chunks.length + 1;
    const chunkSummaries = [];

    for (let i = 0; i < chunks.length; i++) {
      onProgress?.({ step: i + 1, total: totalSteps, label: `Section ${i + 1}/${chunks.length}…` });
      const msgs = [sysMsg, { role: 'user', content: `Points clés de cette section en français (markdown) :\n\n${chunks[i]}` }];
      const r = await runLLM(msgs, chunks[i]);
      chunkSummaries.push(r.response);
      modelUsed = r.model;
    }

    onProgress?.({ step: totalSteps, total: totalSteps, label: 'Synthèse finale…' });
    const combined = chunkSummaries.map((s, i) => `### Section ${i + 1}\n${s}`).join('\n\n');
    const finalMsgs = [sysMsg, { role: 'user', content: `${fullPrompt}\n\nRésumés des sections :\n\n${combined}` }];
    const r = await runLLM(finalMsgs, combined);
    analysisResponse = r.response;
    modelUsed        = r.model;
  } else {
    // Single pass — truncate if necessary
    const MAX_WORDS = 8_000;
    let analysisText = transcription;
    if (wordCount > MAX_WORDS) {
      const half = Math.floor(MAX_WORDS / 2);
      analysisText = words.slice(0, half).join(' ') + '\n\n[… contenu tronqué …]\n\n' + words.slice(-half).join(' ');
    }
    onProgress?.({ step: 1, total: 1, label: 'Analyse en cours…' });
    const msgs = [sysMsg, { role: 'user', content: `${fullPrompt}\n\nTranscription audio :\n${analysisText}` }];
    const r = await runLLM(msgs, analysisText);
    analysisResponse = r.response;
    modelUsed        = r.model;
  }

  return {
    summary: analysisResponse.trim(), model_used: modelUsed,
    ...(usedExamples.length > 0 ? { used_examples: usedExamples } : {}),
  };
}

async function deleteNeuron(id) {
  await ensureOllamaAvailableOrThrow();
  return deleteNeuronFromIndex(env.LANCEDB_PATH, id);
}

async function runCheckOnly() {
  const health = await healthSnapshot();
  console.log(JSON.stringify({
    ok: health.ollama_connected && health.models_available.length === 2,
    ...health
  }, null, 2));
  process.exit(health.ollama_connected ? 0 : 1);
}

const services = {
  embeddingModel: env.EMBEDDING_MODEL,
  answerModel: env.ANSWER_MODEL,
  lancedbPath: env.LANCEDB_PATH,
  getAllNeurons: async () => getAllNeurons(env.LANCEDB_PATH),
  embedText: async (text) => embedText(ollamaClient, env.EMBEDDING_MODEL, text),
  searchVector: async (vector, { limit = 5, threshold = 0.2, filterByKinds = [] } = {}) => {
    return searchNeurons(env.LANCEDB_PATH, vector, {
      limit,
      threshold,
      filterByKinds,
    });
  },
  healthSnapshot,
  indexNeuron: async (payload) => {
    const started = Date.now();
    const result = await indexNeuron(payload);
    result.latency_ms = Date.now() - started;
    return result;
  },
  searchNeurons: async (payload) => {
    const started = Date.now();
    const result = await searchNeuronsEndpoint(payload);
    result.latency_ms = Date.now() - started;
    return result;
  },
  answerQuestion: async (payload) => {
    const started = Date.now();
    try {
      const result = await answerQuestion(payload);
      result.latency_ms = Date.now() - started;
      insertActivityLog({
        opType: 'question', item: String(payload.question ?? '').slice(0, 200),
        result: 'success', durationMs: Date.now() - started, modelUsed: result.model_used,
      });
      return result;
    } catch (err) {
      insertActivityLog({ opType: 'question', item: String(payload.question ?? '').slice(0, 200), result: 'failure', reason: err.message, durationMs: Date.now() - started });
      throw err;
    }
  },
  captureInput: async (payload) => {
    const started = Date.now();
    const result = await captureInput(payload);
    result.latency_ms = Date.now() - started;
    const limited = result?.child?.metadata?.status === 'limited';
    insertActivityLog({
      opType: 'capture', item: result?.child?.title ?? String(payload ?? '').slice(0, 200),
      result: limited ? 'failure' : 'success',
      reason: limited ? (result?.child?.metadata?.error ?? 'capture limitée') : null,
      durationMs: Date.now() - started,
    });
    return result;
  },
  deepCapture: async (url) => {
    const started = Date.now();
    try {
      const result  = await deepCapture(url);
      result.latency_ms = Date.now() - started;
      insertActivityLog({
        opType: 'capture_deep', item: result?.child?.title ?? url,
        result: result.fallback ? 'failure' : 'success',
        reason: result.fallback ? (result.reason ?? 'extraction impossible') : null,
        durationMs: Date.now() - started, modelUsed: result.model_used ?? null,
      });
      return result;
    } catch (err) {
      insertActivityLog({ opType: 'capture_deep', item: url, result: 'failure', reason: err.message, durationMs: Date.now() - started });
      throw err;
    }
  },
  deepCaptureText: async (text, source, url, styleExampleType) => {
    const started = Date.now();
    try {
      const result  = await deepCaptureText(text, source, url, styleExampleType);
      result.latency_ms = Date.now() - started;
      insertActivityLog({
        opType: 'capture_deep', item: result?.child?.title ?? source ?? 'texte collé',
        result: result.fallback ? 'failure' : 'success',
        reason: result.fallback ? (result.reason ?? 'extraction impossible') : null,
        durationMs: Date.now() - started, modelUsed: result.model_used ?? null,
      });
      return result;
    } catch (err) {
      insertActivityLog({ opType: 'capture_deep', item: source ?? 'texte collé', result: 'failure', reason: err.message, durationMs: Date.now() - started });
      throw err;
    }
  },
  deleteNeuron,
  getAllNeuronsForBackup: async () => getAllNeuronsForBackup(env.LANCEDB_PATH),
  optimizeIndex: async () => optimizeTable(env.LANCEDB_PATH),
  getFragmentStats: async () => getFragmentStats(env.LANCEDB_PATH),
  ollamaHealth,
  isOllamaError,
  invalidateInstalledModelCache,
  ollamaUrl: env.OLLAMA_URL,
  getProtectedModels: () => [
    env.EMBEDDING_MODEL,
    env.ANSWER_MODEL,
    getRouterSettings()?.fallback_model ?? 'llama3.2:3b',
  ],
  compareModels: async (params) => compareModels(params),
  deepCaptureWhisper,
  resummariseTranscription,
  // 100% local inference helpers (used by candidature route — cloud NEVER called)
  runLocalStandard: async (messages) => {
    const text = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
    return { text, model: env.ANSWER_MODEL };
  },
  runLocalPowerful: async (messages) => {
    const installedNames = await getCachedInstalledModelNames();
    const actualModel = resolvePowerfulModel(installedNames, getRouterSettings());
    if (_powerfulBusy) {
      const waitStart = Date.now();
      while (_powerfulBusy && Date.now() - waitStart < 180_000) {
        await new Promise(r => setTimeout(r, 2_000));
      }
    }
    _powerfulBusy = true;
    try {
      await unloadModel(ollamaClient, env.ANSWER_MODEL);
      const text = await chatCompletionPowerful(ollamaClient, actualModel, messages);
      return { text, model: actualModel };
    } catch (err) {
      // Fallback to 7b if 14b fails
      logger.warn({ model: actualModel, error: err.message }, '14b failed in candidature, fallback 7b');
      const text = await chatCompletion(ollamaClient, env.ANSWER_MODEL, messages);
      return { text, model: env.ANSWER_MODEL };
    } finally {
      // Powerful model evicts nomic-embed-text from VRAM — re-warm it so the next index is fast
      embedText(ollamaClient, env.EMBEDDING_MODEL, 'warmup').catch(() => {});
      _powerfulBusy = false;
    }
  },
  ensureOllamaAvailableOrThrow,
};

if (process.argv.includes('--check')) {
  await runCheckOnly();
}

const app = new Hono();

const DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://localhost:5173',
  'https://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // LAN origins — both HTTP and HTTPS (mobile uses HTTPS for SW support)
  ...(LOCAL_IP ? [
    `http://${LOCAL_IP}:5173`,
    `https://${LOCAL_IP}:5173`,
    `http://${LOCAL_IP}:3000`,
    `https://${LOCAL_IP}:3000`,
  ] : []),
]);

function isLanOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(hostname);
  } catch { return false; }
}

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (DEV_ORIGINS.has(origin)) return origin;
    if (LOCAL_NETWORK && isLanOrigin(origin)) return origin;
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));

// Destructive routes (DELETE methods, POST /api/backup/import) are protected
// by loopback binding (127.0.0.1 by default) + strict CORS/Origin validation
// above + exact HTTP method/path matching in each route + input validation
// in each handler. An X-Docteur-Token mechanism was tried here in an earlier
// pass and removed: Origin is a client-supplied header that only a real
// browser is prevented from forging (enforced by the browser itself, not the
// server) — any non-browser local process (curl, malware under the same
// Windows account) can set an arbitrary Origin and obtain the token exactly
// as easily as it could call a destructive route directly, so the token
// added no real barrier beyond what CORS already provides, at the cost of
// extra complexity. LOCAL PROCESS AUTHENTICATION IS NOT SUPPORTED — a
// process already running under the same Windows account as Docteur is
// trusted, consistent with the rest of the app's local-only threat model
// (the SQLite DB and DPAPI-encrypted keys carry the same exposure).

app.use('*', async (c, next) => {
  const started = Date.now();
  try {
    await next();
  } finally {
    const response = c.res;
    const latencyMs = Date.now() - started;
    const endpoint = `${c.req.method} ${new URL(c.req.url).pathname}`;
    const storedPayload = c.get('requestPayload') ?? null;
    const modelUsed = c.get('modelUsed') ?? null;
    const ok = response?.status ? response.status < 400 : true;
    const payloadSize = storedPayload !== null ? sanitizePayloadSize(storedPayload) : Number(c.req.header('content-length') ?? 0);

    logger.info({
      endpoint,
      latency_ms: latencyMs,
      model_used: modelUsed,
      payload_size: payloadSize,
      status_code: response?.status ?? 200,
      ok
    }, 'request completed');

    logRequest({
      endpoint,
      latencyMs,
      modelUsed,
      payloadSize,
      statusCode: response?.status ?? 200,
      ok,
      message: ok ? null : 'request failed'
    });
  }
});

app.route('/api', createHealthRoute({ services }));
app.route('/api', createIndexRoute({ services, logger }));
app.route('/api', createCaptureRoute({ services, logger }));
app.route('/api', createSearchRoute({ services }));
app.route('/api', createAnswerRoute({ services }));
app.route('/api', createNeuronRoute({ services, logger }));
app.route('/api', createJobsRoute());
app.route('/api', createCompareRoute({ services }));
app.route('/api', createWebAnswerRoute({ services, logger }));
app.route('/api', createWebExploreRoute({ services, logger }));
app.route('/api', createFilesRoute({ rootDir, logger }));
app.route('/api', createBackupRoute({ services, logger }));
app.route('/api', createCorpusRoute({ services, logger }));
app.route('/api', createActivityRoute({ logger }));
app.route('/api', createRouterRoute({ services }));
app.route('/api', createFreeAiRoute({ logger }));
app.route('/api', createOllamaRoute({ services }));
app.route('/api', createLocalAiRoute({ services }));
app.route('/api', createDownloadRoute({ services, logger }));
app.route('/api', createResearchRoute({
  logger,
  services,
  fallbackChat: (messages) => chatCompletion(ollamaClient, env.ANSWER_MODEL, messages),
}));
app.route('/api', createImageRoute({ logger }));
app.route('/api', createImageGenerationRoute({ logger }));
app.route('/api', createVisionRoute({ ollamaClient, env, logger }));
app.route('/api', createChatRoute({ ollamaClient, env, logger }));
app.route('/api', createClarifyRoute({ logger }));
app.route('/api', createPdfRoute({ services, logger }));
app.route('/api', createCandidatureRoute({
  logger,
  runLocalStandard:              services.runLocalStandard,
  runLocalPowerful:              services.runLocalPowerful,
  ensureOllamaAvailableOrThrow:  services.ensureOllamaAvailableOrThrow,
}));
app.route('/api', createCvImportRoute({ logger }));
app.route('/api', createAgentsRoute({ logger, ollamaClient, services }));
const externalAgents = new ExternalAgents({
  projectRoot: path.resolve(rootDir, '..'),
  dataDir: path.resolve(rootDir, 'data/external-agents'),
  strictLocal: () => getRouterSettings()?.strict_local_mode === true,
});
app.route('/api', createExternalAgentsRoute({ service: externalAgents }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void Promise.allSettled([externalAgents.shutdown(), shutdownSherlock()]).finally(() => process.exit(0));
});
app.route('/api', createVideoSummaryRoute({ services, ollamaClient, logger }));
app.route('/api', createOpenMontageRoute());
app.route('/api', createMetaGptRoute({ logger }));
app.route('/api', createCyberAuditRoute({ logger }));
app.route('/api', createMonitorRoute({ logger, ollamaClient, ollamaModel: env.ANSWER_MODEL }));
app.route('/api', createMaitreRoute({ logger, ollamaClient, ollamaModel: env.ANSWER_MODEL }));
app.route('/api', createSkillsRoute({ services, logger }));
app.route('/api', createPromptGeneratorRoute({ services, ollamaClient, logger }));
app.route('/api', createTeacherRoute({ services, ollamaClient, logger }));
app.route('/api', createTodoRoute());
app.route('/api', createPrivacyRoute({ logger }));
app.route('/api', createConnectorsRoute({ services, logger }));
app.route('/api', createMemoryRoute({ logger }));
app.route('/api', createNotebookRoute({ ollamaClient, env, logger }));
app.route('/api', createNotebookLmRoute({ logger }));
app.route('/api', createBrowserRoute({ logger }));
app.route('/api', createSherlockRoute({ services, logger }));
app.route('/api', createCodeIntelRoute({ logger }));
app.route('/api', createInvestmentRoute({ services, logger }));
app.route('/api', createSalesRoute({ services, logger }));
app.route('/api', createSecretScanRoute({ logger }));
app.route('/api', createVoiceRoute({ logger }));
app.route('/api', createInboxRoute({ defaultDir: path.resolve(rootDir, 'data/inbox'), logger }));
app.route('/api', createKiwixRoute({ services, logger }));
app.route('/api', createAudioPlayerRoute({ logger }));
app.route('/api', createStyleExamplesRoute({ services, logger }));
app.route('/api', createOmegaRoute({ logger }));
// OMEGA V1 Phase 3 — VIEW ONLY screen-streaming data path. Deliberately
// registered as its own route group (NOT createOmegaRoute's loopback-
// only /omega/* middleware) because this specific surface must be
// reachable from a second physical device on the LAN, by design — see
// routes/omega-view.js's header comment for the full auth-model
// rationale (session-token/nonce authentication instead of a loopback
// guard). No new listener/port: rides the same existing HTTP server and
// the same existing LOCAL_NETWORK/CORS LAN-exposure decision as every
// other route in this file.
app.route('/api', createOmegaViewRoute({ logger }));
// OMEGA V1 Phase 4 — OMEGA_INTERACTIVE mouse/keyboard input-injection
// data path. Same rationale as the VIEW route group above: no new
// listener/port, session-token/nonce authentication instead of a
// loopback guard (must be LAN-reachable by the controller device), PLUS
// an additional server-side permission check (permissionLevel >=
// OMEGA_INTERACTIVE) on every single route — see
// routes/omega-interactive.js's header comment.
app.route('/api', createOmegaInteractiveRoute({ logger }));
// OMEGA V1 Phase 5 — semantic ADMIN actions only. This rides the same
// existing listener/port and inherits the Phase 4.1 TLS boundary; high-impact
// requests still require a visible local approval before any native API call.
app.route('/api', createOmegaAdminRoute({ logger }));

app.onError((error, c) => {
  const status = services.isOllamaError(error) ? 503 : 500;
  // Strip any ?key=... or key=... fragments before logging/sending (Gemini key in URL)
  const safeMsg = error.message.replace(/key=[A-Za-z0-9_\-.]+/gi, 'key=***');
  logger.error({ error: safeMsg, status }, 'request error');
  return c.json({ error: safeMsg }, status);
});

app.notFound((c) => c.json({ error: 'Route introuvable' }, 404));

const protocol = USE_HTTPS ? 'https' : 'http';

// Single-instance guard: identify who (if anyone) already holds env.PORT
// before attempting to bind it. Never kills anything — a recognized second
// Cortex instance is refused with a clear message, an unknown occupant fails
// closed with its PID/path so the operator can decide. If ownership can't be
// determined (non-Windows, or the check itself fails), we don't block
// startup on that — the existing EADDRINUSE handler below still catches a
// real collision, just without the friendlier "who owns it" detail.
const portOwner = await checkPortOwnership(env.HOST, env.PORT);
if (portOwner.state === 'owned_by_cortex') {
  logger.error({ host: env.HOST, port: env.PORT, pid: portOwner.pid }, 'CORTEX_ALREADY_RUNNING');
  logger.error('An existing cortex-server instance is already listening on this port. Stop it first (close its window / Ctrl+C) before starting another — refusing to start a second instance.');
  process.exit(1);
} else if (portOwner.state === 'owned_by_unknown') {
  logger.error({ host: env.HOST, port: env.PORT, pid: portOwner.pid, name: portOwner.name, cmdLine: portOwner.cmdLine }, 'CORTEX_PORT_OWNED_BY_UNKNOWN_PROCESS');
  logger.error('Port is occupied by a process that is not a recognized cortex-server instance. Refusing to start or kill it automatically — identify and stop it manually, then retry.');
  process.exit(1);
}

const httpServer = serve({
  fetch: app.fetch,
  port: env.PORT,
  hostname: env.HOST,
  // When LOCAL_NETWORK=true and certs exist, serve over HTTPS so the phone's
  // service worker can register (SW requires a secure context or localhost).
  ...(USE_HTTPS ? {
    createServer: (_, handler) => https.createServer(
      { key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_PEM) },
      handler,
    ),
  } : {}),
}, () => {
  logger.info({ host: env.HOST, port: env.PORT, protocol, ollama_url: env.OLLAMA_URL, local_network: LOCAL_NETWORK }, 'cortex server started');
  if (LOCAL_NETWORK && LOCAL_IP) {
    logger.info(`\n${'─'.repeat(56)}\n  ACCES MOBILE ACTIF\n  Frontend : ${protocol}://${LOCAL_IP}:5173\n  API      : ${protocol}://${LOCAL_IP}:${env.PORT}\n${'─'.repeat(56)}`);
  }
  scheduleDailyBackup(env.LANCEDB_PATH, logger);
  startAgentScheduler({ logger, ollamaClient, services });
  startInboxWatcher({ defaultDir: path.resolve(rootDir, 'data/inbox'), logger });
  try {
    startMonitorServiceIfAutostart({ ollamaClient, ollamaModel: env.ANSWER_MODEL, logger });
  } catch (err) {
    logger.warn({ err: err?.message }, 'observateur monitor: autostart failed, continuing without it');
  }
  // Compact at 1000 active fragments or when obsolete versions occupy disk.
  // Runs in background so startup is not blocked.
  let checkingCompaction = false;
  const checkCompaction = async () => {
    if (checkingCompaction) return;
    checkingCompaction = true;
    try {
      const stats = await getFragmentStats(env.LANCEDB_PATH);
      if (!needsCompaction(stats)) return;
      logger.info({ fragments: stats.numFragments, diskBytes: stats.diskBytes }, 'LANCEDB_AUTO_COMPACT_START');
      const result = await optimizeTable(env.LANCEDB_PATH);
      logger.info(result, 'LANCEDB_AUTO_COMPACT_DONE');
    } catch (err) {
      logger.warn({ error: err.message }, 'LANCEDB_AUTO_COMPACT_FAILED');
    } finally { checkingCompaction = false; }
  };
  void checkCompaction();
  // Recheck during long-running capture/import sessions, including obsolete
  // versions that can consume disk even when active fragments are below 1000.
  setInterval(() => void checkCompaction(), 5 * 60_000).unref();
  // Clean up orphan subtitle temp dirs older than 1h (left by crashed downloads)
  try {
    const tmpDir  = os.tmpdir();
    const cutoff  = Date.now() - 60 * 60 * 1000;
    const entries = fs.readdirSync(tmpDir);
    let cleaned   = 0;
    for (const entry of entries) {
      if (!entry.startsWith('docteur-subs-')) continue;
      const full = path.join(tmpDir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          cleaned++;
        }
      } catch { /* skip locked or vanished entries */ }
    }
    if (cleaned > 0) logger.info({ cleaned }, 'orphan tmp dirs cleaned');
  } catch { /* non-fatal */ }
  registerKiwixShutdownHook(logger);
  // Check yt-dlp availability (non-blocking)
  checkYtDlp().then(v => {
    if (v) logger.info({ version: v }, 'yt-dlp trouvé');
    else    logger.warn('yt-dlp introuvable — téléchargement vidéo désactivé. Installe avec : winget install yt-dlp');
  }).catch(err => {
    // checkYtDlp() itself never rejects today (every failure path resolves
    // null — see lib/ytdlp.js), but this call is defended anyway so a future
    // change to that function can never produce an unhandled rejection here.
    logger.warn({ err: err?.message }, 'yt-dlp check échouée de façon inattendue — téléchargement vidéo probablement désactivé');
  });
});

// serve() returns the underlying node:http(s) Server; without this listener,
// EADDRINUSE surfaces as Node's default unhandled-'error'-event crash (an
// opaque stack trace) instead of a clear, actionable log line. This never
// falls back to another port — the frontend expects env.PORT specifically —
// it only makes the existing failure legible before exiting non-zero.
httpServer.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    logger.error({ host: env.HOST, port: env.PORT }, 'CORTEX_PORT_IN_USE');
    process.exit(1);
  }
  logger.error({ error: error?.message ?? String(error) }, 'cortex server listen error');
  process.exit(1);
});
