import type { Page, Block } from '../types';
import { pageToContent } from './pageToContent';
import { DEEP_CAPTURE_TIMEOUT_MS } from '../capturePipeline';
export { DEEP_CAPTURE_TIMEOUT_MS } from '../capturePipeline';

const BASE      = `${window.location.protocol}//${window.location.hostname}:3001`;
const TIMEOUT        = 90_000;   // ms per request (default)
const TIMEOUT_ANSWER = 120_000;  // ms for /api/answer — first call loads model into VRAM
const MAX_RETRY = 2;        // network retries (not HTTP errors)

// ── Types ──────────────────────────────────────────────────────────────────

export interface HealthStatus {
  ollama_connected: boolean;
  models?: string[];
  lancedb_ready?: boolean;
  [key: string]: unknown;
}

export interface IndexResult {
  ok: boolean;
  latency_ms: number;
  dimensions?: number;
  embedding_ms?: number;
  lancedb_ms?: number;
}

export interface IndexOptimizeResult {
  ok: boolean;
  skipped?: boolean;
  before?: { fragments: number; rows: number; bytes: number };
  after?: { fragments: number; rows: number; bytes: number };
  durationMs?: number;
}

export interface IndexFragmentStats {
  numFragments: number;
  numSmallFragments: number;
  numRows: number;
  numIndices: number;
  totalBytes: number;
  diskBytes: number;
  autoCompactThreshold: number;
}

export interface SearchHit {
  id: string;
  title: string;
  kind: string;
  score: number;
  content_preview?: string;
}

export interface SearchResult {
  results: SearchHit[];
  count: number;
  latency_ms: number;
}

export interface AnswerResult {
  answer: string;
  sources: Array<{ id: string; title: string; score: number; kind?: string; isKiwix?: boolean; book?: string; articlePath?: string }>;
  latency_ms: number;
  model_used: string | null;
  router_level?: number | null;
  routing_reason?: string | null;
  has_private_sources?: boolean;
  // NB-7 — Docteur Memory in the main chat (additive; memoryUsed is always an array when the server is NB-7)
  memoryUsed?: ChatMemoryUsed[];
  memory?: { enabled: boolean; requestId: string | null; notice: string | null; retrievalMode: string | null; vectorStatus: string | null; historical: boolean; project: string | null; notebook: string | null;
    conflicts: Array<{ conflictId: string | null; kind: string; memoryA?: string; memoryB?: string; detail?: string }>; skipped: Array<{ memoryId: string | null; code: string }>; citedMemoryIds: string[]; citedSources: string[]; timingMs: number };
  notebookSources?: Array<{ marker: string; type: 'DOCUMENT_CHUNK' | 'AI_HISTORY_MESSAGE'; id: string; ref: string; title: string; trustLevel: string | null }>;
  citations?: ChatCitation[];
}
export type ChatCitationType = 'NEURON' | 'MEMORY' | 'DOCUMENT_CHUNK' | 'AI_HISTORY_MESSAGE';
export interface ChatCitation { type: ChatCitationType; id: string; marker?: string }
export interface ChatMemoryUsed {
  marker: string; memoryId: string; type: string; scope: { kind: 'GLOBAL' | 'PROJECT' | 'NOTEBOOK'; projectId: string | null; notebookId: string | null }; status: string; isHistorical: boolean;
  score: number; reason: 'FTS' | 'VECTOR' | 'HYBRID'; statement: string; provenance: string; trustLevel: string; effectiveFrom: string; effectiveUntil: string | null;
  evidence: Array<{ kind: string; ref: string; provider: string | null; status: string }>;
}

export type CorpusScope = 'all' | 'personal' | 'reference';

export interface CorpusScanResult {
  ok: boolean;
  totalFound: number;
  matchedCount: number;
  willImportCount: number;
  truncated: boolean;
  rejectedExt: number;
  rejectedSize: number;
  estimatedSizeBytes: number;
  sampleTitles: string[];
  limit: number;
}

export interface CorpusImportResult {
  ok: boolean;
  corpusId: string;
  jobId: string;
  matched: number;
}

export interface CorpusJobStatus {
  id: string;
  done: number;
  total: number;
  status: 'running' | 'done' | 'error';
  errors: Array<{ name: string; error: string }>;
}

export interface CorpusSource {
  id: string;
  name: string;
  article_count: number;
  size_bytes: number;
  keywords: string;
  status: string;
  error_count: number;
  created_at: string;
}

export interface CorpusFilters {
  keywords?: string;
  minSize?: number;
  maxSize?: number;
  limit?: number;
}

// ── Journal d'activité ────────────────────────────────────────────────────

export interface ActivityLogEntry {
  id:           number;
  timestamp:    string;
  op_type:      string;
  item:         string;
  result:       'success' | 'failure';
  reason:       string | null;
  duration_ms:  number | null;
  model_used:   string | null;
}

export interface ActivityLogFilters {
  opType?: string;
  result?: 'success' | 'failure';
  from?:   string;
  to?:     string;
  q?:      string;
  limit?:  number;
  offset?: number;
}

export interface ClarifyQuestion {
  id:      string;
  text:    string;
  choices: string[];
}

export interface ClarifyResult {
  needs_clarification: boolean;
  questions?:          ClarifyQuestion[];
  cloud_unavailable?:  boolean;
  provider?:           string;
}

export interface CompareSource {
  id:    string;
  title: string;
  score: number;
}

export interface CompareModelResult {
  model_id:   string;
  answer:     string;
  model_used: string;
  provider:   string;
  latency_ms: number;
  sources:    CompareSource[];
}

export interface CompareEvent {
  type:                'ready' | 'progress' | 'result' | 'error' | 'done';
  has_private_sources?: boolean;
  sources_count?:       number;
  model_id?:            string | null;
  status?:              'running';
  answer?:              string;
  model_used?:          string;
  provider?:            string;
  latency_ms?:          number;
  sources?:             CompareSource[];
  error?:               string;
}

export interface WebSearchResult {
  title:   string;
  url:     string;
  snippet: string;
  domain:  string;
}

export interface WebDeepSource {
  title:  string;
  url:    string;
  domain: string;
  ok:     boolean;
}

export interface WebDeepEvent {
  type:       'status' | 'page' | 'result' | 'cancelled' | 'error' | 'done';
  phase?:     'searching' | 'fetching' | 'synthesizing';
  message?:   string;
  index?:     number;
  total?:     number;
  title?:     string;
  url?:       string;
  domain?:    string;
  ok?:        boolean;
  content?:   string;
  sources?:   WebDeepSource[];
  model_used?: string;
  latency_ms?: number;
  error?:     string;
}

export interface WebAnswerSource {
  title:  string;
  url:    string;
  domain: string;
}

export interface WebAnswerEvent {
  type:        'status' | 'result' | 'error' | 'done';
  phase?:      'searching' | 'fetching' | 'answering';
  message?:    string;
  index?:      number;
  total?:      number;
  answer?:     string;
  sources?:    WebAnswerSource[];
  model_used?: string | null;
  latency_ms?: number;
  error?:      string;
}

export interface ServerJob {
  id:           string;
  operation:    string;
  current:      number;
  total:        number;
  currentLabel: string;
  okCount:      number;
  fallbackCount: number;
  errorCount:   number;
  startedAt:    number;
  updatedAt:    number;
  status:       'running' | 'done' | 'error';
  summary:      string | null;
}

export interface RouterModelStatus {
  model: string;
  level: number;
  level_label: string;
  installed: boolean;
  install_cmd: string;
}

// Live provider health, never includes the actual API key/secret.
export type ProviderHealthState =
  | 'ready' | 'rate_limited' | 'quota_exhausted' | 'auth_required'
  | 'offline' | 'model_unavailable' | 'error' | 'degraded' | 'timeout';

export interface ProviderOverview {
  id: string;
  label: string;
  kind: 'local' | 'cloud';
  authType?: 'api-key' | 'oauth-token' | 'none';
  // Which auth mechanism is actually in effect for oauth-token providers —
  // 'setup_token' (CLAUDE_CODE_OAUTH_TOKEN), 'cli_session' (`claude auth
  // login` / `codex login`), or 'none'. Never carries the token value itself.
  authMode?: 'setup_token' | 'cli_session' | 'none';
  // For anthropic/claude-oauth and openai/codex pairs: which backend is
  // currently selected for that family ('subscription' | 'api').
  mode?: 'subscription' | 'api';
  // Whether the CLI binary itself was found on PATH (claude-oauth/codex only).
  cli_installed?: boolean;
  paid: boolean;
  enabled: boolean;
  configured: boolean;
  status: ProviderHealthState;
  in_cooldown: boolean;
  cooldown_remaining_ms: number;
  default_model: string | null;
  available_models?: string[];
  masked_key?: string | null;
  endpoint?: string | null;
}

export interface ProvidersOverviewResult {
  providers: ProviderOverview[];
  paying_apis_enabled: boolean;
  strict_local_mode: boolean;
}

// Free AI Finder — discovery-only catalog of public free-tier/trial LLM API
// providers (source: free-llm-api-hub). Field names mirror the upstream
// dataset schema; anything the dataset doesn't provide comes back as null,
// never guessed. See cortex-server/src/lib/free-ai-catalog.js.
export interface FreeAiProvider {
  id: string;
  name: string;
  category: 'ongoing' | 'trial' | null;
  freeType: 'perpetual' | 'renewing-quota' | 'recurring-credit' | 'trial-credit' | null;
  freeTier: string | null;
  rateLimits: string | null;
  notes: string | null;
  bestFor: string | null;
  modalities: string[];
  modelsFree: string[] | null;
  expires: string | null;
  cardRequired: boolean | null;
  phoneRequired: boolean | null;
  commercialUse: boolean | null;
  openAICompatible: boolean | null;
  openAIBaseUrl: string | null;
  docsUrl: string | null;
  verified: boolean;
  lastVerified: string | null;
  added: string | null;
  nativeDocteurProvider: string | null;
  configuredInDocteur: boolean;
  availableViaFreeLLMAPI: boolean;
  docteurState: 'configured' | 'native_not_configured' | 'maybe_via_freellmapi' | 'not_integrated';
  verificationFreshness: 'fresh' | 'aging' | 'recheck' | 'unknown';
}

export interface FreeAiCatalogResult {
  providers: FreeAiProvider[];
  source: string;
  sourceRepo?: string;
  catalogVersion: string | null;
  catalogGenerated: string | null;
  fetchedAt: string | null;
  stale: boolean;
  strictLocalActive?: boolean;
  strictLocalBlockedRefresh?: boolean;
  warning: string | null;
}

export interface RouterSettings {
  router_enabled: boolean;
  fallback_model: string;
  cloud_enabled: boolean;
  paying_apis_enabled: boolean;
  cloud_preference?: 'local' | 'balanced' | 'quality';
  strict_local_mode?: boolean;
  groq_model?: string;
  powerful_model?: string;
  chat_model?: string;
  // Mutually-exclusive backend per family — 'subscription' uses the CLI
  // (Claude Code / Codex, no per-token API cost) or 'api' uses the paid key
  // (ANTHROPIC_API_KEY / OPENAI_API_KEY). Only one is ever used by the router.
  claude_mode?: 'subscription' | 'api';
  openai_mode?: 'subscription' | 'api';
  freellmapi?: {
    enabled: boolean;
    baseUrl: string;
    timeout: number;
    mode: 'auto' | 'manual';
    allowText: boolean;
    allowImage: boolean;
    allowVideo: boolean;
    allowAudio: boolean;
    allowFallback: boolean;
    freeOnly: boolean;
    textModel: string;
    imageModel: string;
    videoModel: string;
    audioModel: string;
  };
  // Free AI Finder progressive disclosure (AI-5). Default false — Settings
  // shows only a small recommended subset until this is explicitly enabled.
  always_show_all_free_apis?: boolean;
}

export interface RouterStatus {
  statuses: RouterModelStatus[];
  settings: RouterSettings;
  ollama_connected: boolean;
  cloud_keys?: CloudKeysMasked;
}

export interface OllamaModelDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaModelInfo {
  name: string;
  model?: string;
  modified_at?: string | null;
  size: number;
  digest?: string;
  details?: OllamaModelDetails;
}

export interface OllamaModelsResult {
  connected: boolean;
  models: OllamaModelInfo[];
  total_size: number;
  free_bytes: number | null;
  guarded_models: string[];
  error?: string;
}

export interface OllamaPullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  model?: string;
  error?: string;
  done?: boolean;
}

// --- Local AI catalog (AI-3/AI-4) --- mirrors cortex-server/src/lib/local-ai-catalog.js

export type TrustLevel = 'OFFICIAL' | 'VERIFIED_COMMUNITY' | 'COMMUNITY' | 'UNVERIFIED';
export type ExecutionLocation = 'LOCAL' | 'CLOUD';
export type FitRating = 'EXCELLENT' | 'GOOD' | 'TIGHT' | 'NOT_RECOMMENDED' | 'UNKNOWN';
export type RequirementConfidence = 'OFFICIAL_REQUIREMENT' | 'COMMUNITY_ESTIMATE' | 'DERIVED_ESTIMATE' | 'UNKNOWN';

export interface ModelCatalogEntry {
  canonicalId: string;
  name: string;
  family: string;
  publisher: string;
  provenance: 'official' | 'community_quant' | 'community_modified';
  trustLevel: TrustLevel;
  upstreamCanonicalId: string | null;
  officialSourceUrl: string | null;
  huggingFaceUrl: string | null;
  githubUrl: string | null;
  releaseDate: string | null;
  lastVerifiedAt: string;
  license: string | null;
  commercialUse: 'unrestricted' | 'conditional' | 'non_commercial' | 'unknown';
  additionalPolicies: string[];
  architecture: { type: 'dense' | 'moe' | 'unknown'; totalParameters: number | null; activeParameters: number | null };
  contextLength: { native: number | null; extended: number | null } | null;
  capabilities: {
    reasoning: boolean; coding: boolean; toolCalling: boolean;
    vision: boolean; audio: boolean; video: boolean; multilingual: boolean;
  };
  modalities: string[];
  strengths: string[];
  limitations: string[];
  lifecycle: { status: 'current' | 'superseded' | 'obsolete' | 'unknown'; staleAfter: string | null; replacedBy: string | null };
  useCaseTags: string[];
}

export interface ModelDistribution {
  id: string;
  canonicalId: string;
  runtime: 'OLLAMA' | 'LM_STUDIO' | 'GGUF' | 'LLAMA_CPP' | 'TRANSFORMERS';
  source: string;
  sourceUrl: string | null;
  ollamaPullName: string | null;
  huggingFaceRepo: string | null;
  localArtifactPath: string | null;
  artifactSizeBytes: number | null;
  precision: string | null;
  quantization: string | null;
  executionLocation: ExecutionLocation;
  verified: boolean;
  lastVerifiedAt: string;
  requiresRemoteCode: boolean | 'unknown' | 'not_applicable';
  estimatedRequirements: { ramBytes: number | null; vramBytes: number | null; diskBytes: number | null; confidenceType: RequirementConfidence } | null;
}

export interface CatalogMeta {
  catalogVersion: string;
  generatedAt: string;
  staleAfterDays: number;
  stale: boolean;
  modelCount: number;
  distributionCount: number;
}

export interface LocalAiCatalogResult {
  models: ModelCatalogEntry[];
  distributions: ModelDistribution[];
  meta: CatalogMeta;
}

export interface GpuInfo {
  name: string;
  vendor: string | null;
  vramBytes: number | null;
  source: string;
}

export interface LocalHardwareProfile {
  platform: string;
  arch: string;
  cpuModel: string | null;
  logicalCores: number;
  totalRamBytes: number;
  freeRamBytes: number;
  gpus: GpuInfo[];
  freeDiskBytes: number | null;
  osVersion: string | null;
  detectedAt: string;
}

export interface FitResult {
  rating: FitRating;
  reasons: string[];
  warnings: string[];
  estimates: { ramBytes: number | null; vramBytes: number | null; diskBytes: number | null };
  confidence: string;
}

export interface LocalAiRecommendationEntry {
  model: ModelCatalogEntry;
  distribution: ModelDistribution;
  fit: FitResult;
  installed: boolean;
}

export interface LocalAiRecommendationsResult {
  results: LocalAiRecommendationEntry[];
  hardwareProfile: LocalHardwareProfile;
  catalogMeta: CatalogMeta;
}

export interface LocalAiInstalledResult {
  installedOllamaModels: string[];
  matchedCatalogDistributions: { distributionId: string; canonicalId: string; ollamaPullName: string }[];
}

export interface LocalAiInstallPreviewResult {
  ok: boolean;
  error?: string;
  model?: ModelCatalogEntry;
  distribution?: ModelDistribution;
  fit?: FitResult;
  hardwareProfile?: LocalHardwareProfile;
  alreadyInstalled?: boolean;
  verifiedOllamaPullName?: string;
}

export interface RouterStat {
  chosen_model: string;
  chosen_level: number;
  provider: string | null;
  call_count: number;
  avg_latency_ms: number;
  error_count: number;
  quota_count: number;
}

export interface CloudKeysMasked {
  gemini_key:        string | null;
  groq_key:          string | null;
  openrouter_key:    string | null;
  anthropic_key:     string | null;
  openai_key:        string | null;
  freellmapi_key:    string | null;
  gemini_active:     boolean;
  groq_active:       boolean;
  openrouter_active: boolean;
  anthropic_active:  boolean;
  openai_active:     boolean;
  freellmapi_active: boolean;
  // Nouveaux providers OAuth - toujours null (pas de clé API)
  claude_oauth_key: string | null;
  codex_key:         string | null;
  // Provider local PAIR - pas de clé, mais endpoint configurable
  pair_endpoint:     string | null;
}

// ── Génération d'images ──────────────────────────────────────────────────────

export interface ImageGenCapabilities {
  text_to_image: boolean;
  image_to_image: boolean;
  image_edit: boolean;
  negative_prompt: boolean;
  seed: boolean;
  custom_size: boolean;
}

export interface ComfyUiProviderStatus {
  available: boolean;
  endpoint: string;
  isLocal: boolean;
  classification: 'local';
  version?: string | null;
  gpu?: Array<{ name: string | null; vramTotalMb: number | null; vramFreeMb: number | null }>;
  checkpoints?: string[];
  hasCompatibleModel?: boolean;
  error?: string;
  message?: string;
}

export interface CloudImageProviderStatus {
  configured: boolean;
  provider: string;
  classification: 'free_tier' | 'credit' | 'quota';
  freeTierNote: string;
  billingCaveat?: string;
  capabilities: ImageGenCapabilities;
}

export interface ImageGenProvidersStatus {
  ok: boolean;
  strictLocal: boolean;
  providers: {
    comfyui: ComfyUiProviderStatus;
    cloudflare: CloudImageProviderStatus;
    huggingface: CloudImageProviderStatus;
    pollinations: CloudImageProviderStatus;
  };
}

export interface ImageGenSettingsResult {
  ok: boolean;
  settings: {
    comfyui_endpoint: string;
    priority: 'local' | 'cloud';
    free_cloud_only: boolean;
    comfyuiIsLoopback: boolean;
  };
  keys: {
    cloudflare_account_id: { configured: boolean; status: 'absent' | 'valid' | 'invalid' };
    cloudflare_api_token:  { configured: boolean; status: 'absent' | 'valid' | 'invalid' };
    huggingface_token:     { configured: boolean; status: 'absent' | 'valid' | 'invalid' };
    pollinations_key:      { configured: boolean; status: 'absent' | 'valid' | 'invalid' };
  };
}

export interface ImageGenerationResult {
  image_id: string;
  provider_requested: string;
  provider_used: string;
  model_used: string | null;
  local: boolean;
  fallback: boolean;
  fallback_reason_code: string | null;
  width: number;
  height: number;
  seed: number | null;
  generation_ms: number;
  job_id: string;
  generation_id: string;
}

export interface ImageGenerationRow {
  id: string;
  image_id: string | null;
  prompt: string;
  negative_prompt: string | null;
  provider_requested: string;
  provider_used: string | null;
  model_used: string | null;
  local: number;
  fallback: number;
  fallback_reason_code: string | null;
  width: number | null;
  height: number | null;
  seed: number | null;
  status: string;
  error_code: string | null;
  generation_ms: number | null;
  job_id: string | null;
  neuron_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComfyUiInstallState {
  kind: 'none' | 'managed' | 'external';
  path: string | null;
  status: 'not_installed' | 'installed' | 'stopped' | 'running' | 'starting' | 'incomplete' | 'error';
  version: string | null;
  installedAt?: number | null;
  startWithDocteur: boolean;
  pid: number | null;
  startedAt: number | null;
  lastError?: string | null;
}

export interface ComfyUiReleaseInfo {
  tag: string;
  assetName: string;
  url: string;
  approxSizeBytes: number;
  checksum: string | null;
}

export interface ImageModelCatalogEntry {
  id: string;
  name: string;
  filename?: string;
  source: string;
  license?: string;
  approxSizeGb: number;
  capabilities: ImageGenCapabilities;
  recommendedVramGb?: number;
}

export interface CloudMonthStat {
  provider:    string;
  chosen_model: string;
  call_count:  number;
  error_count: number;
  quota_count: number;
}

export interface ResearchSource {
  title: string;
  url:   string;
}

export type DetailLevel = 'synthese' | 'standard' | 'pedagogique' | 'expert';

export const DETAIL_LEVEL_LABELS: Record<DetailLevel, string> = {
  synthese:    'Synthèse',
  standard:    'Standard',
  pedagogique: 'Pédagogique',
  expert:      'Expert',
};

export interface StyleExampleUsed {
  id:    string;
  title: string;
  type:  string | null;
}

export interface StyleExampleOptions {
  useStyleExamples?: boolean;
  styleExampleType?: string;
}

export interface StyleExampleSettings {
  enabled: boolean;
}

export interface ResearchResult {
  content: string;
  model:   string;
  mode:    'synthese' | 'actualite';
  sources: ResearchSource[];
  warning?: string;
  detailLevel?: DetailLevel;
  usedExamples?: StyleExampleUsed[];
}

export interface ResearchQuota {
  groundingUsed:      number;
  groundingLimit:     number;
  groundingRemaining: number;
}

export interface DeepResearchOptions {
  format: 'document' | 'arborescence';
  depth:  5 | 10 | 15;
  source: 'ia' | 'web';
  detailLevel?: DetailLevel;
}

export interface DeepResearchPlanResult {
  subtopics: string[];
  model:     string;
}

export interface DeepResearchSectionResult {
  content: string;
  model:   string;
  sources: ResearchSource[];
  detailLevel?: DetailLevel;
}

export interface VeilleSettings {
  detailLevel: DetailLevel;
}

// [Article Canonical V1] Same article already in Docteur (opt-in check on new captures).
export interface CanonicalArticleDuplicate {
  duplicate?: boolean;
  existing?: { id: string; title: string; matchedBy: 'canonical_url' | 'content_hash' };
  canonical?: { canonicalUrl: string | null; contentHash: string | null; title: string };
}

export interface CaptureDeepOptions {
  checkDuplicate?: boolean;
}

export interface DeepCaptureResult extends CanonicalArticleDuplicate {
  fallback: boolean;
  needs_whisper?: boolean;
  video_duration?: number | null;
  title?: string;
  channel?: string;
  reason?: string;
  error?: string;
  parent?: CaptureNeuron | null;
  child?: CaptureNeuron | null;
  model_used?: string | null;
  latency_ms?: number;
  captureId?: string;
  partial?: {
    title?: string;
    text?: string;
    word_count?: number;
    imageUrls?: string[];
  } | null;
  imageUrls?: string[];
  extraction?: {
    httpStatus?: number | null;
    finalUrl?: string;
    rawChars?: number;
    renderedChars?: number;
    readabilityChars?: number;
    readabilityWords?: number;
    structuredChars?: number;
    structuredWords?: number;
    semanticChars?: number;
    semanticWords?: number;
    playwrightChars?: number;
    playwrightWords?: number;
    finalChars?: number;
    finalWords?: number;
    finalParagraphs?: number;
    chosenExtractor?: string | null;
    fallbackReason?: string | null;
    qualityStatus?: 'COMPLETE' | 'PARTIAL_EXTRACTION' | 'NO_CONTENT';
    navigationMs?: number;
    waitMs?: number;
    playwrightExtractionMs?: number;
  } | null;
  timings?: {
    fetchMs?: number;
    readabilityMs?: number;
    playwrightMs?: number;
    extractionMs?: number;
    pairAttemptMs?: number;
    aiMs?: number;
    titleMs?: number;
    totalMs?: number;
  };
  groq_fallback?: { reason: string; label: string } | null;
}

export interface WhisperProgress {
  step?: 'download' | 'transcribe' | 'analyse';
  percent?: number;
  label?: string;
  done?: boolean;
  error?: string;
  result?: DeepCaptureResult;
  groq_fallback?: boolean;
  groq_fallback_reason?: string;
  provider?: 'local' | 'groq';
}

export interface WhisperStats {
  today: { groq: number; local: number; groq_minutes: number; local_minutes: number };
  month: { groq: number; local: number };
  last_quota_at: string | null;
}

export interface CaptureNeuron {
  title: string;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
  blocks?: Block[];
}

export type ResummariseLevel = 'short' | 'standard' | 'detailed' | 'exhaustive';

export interface ResummariseProgress {
  step?:  number;
  total?: number;
  label?: string;
  done?:  boolean;
  error?: string;
  result?: { summary: string; model_used: string; used_examples?: StyleExampleUsed[] };
}

export interface BackupEntry {
  name: string;
  size_bytes: number;
  exported_at: string | null;
  neurons_count: number;
}

// ── Persona types ─────────────────────────────────────────────────────────────

export interface PersonaSettings {
  vouvoiement: boolean;
}

// ── Inbox types ───────────────────────────────────────────────────────────────

export interface InboxSettings {
  enabled:    boolean;
  inbox_dir:  string | null;
  frequency:  'hourly' | 'daily' | 'manual';
  last_check: string | null;
}

export interface InboxPending {
  id:         string;
  title:      string;
  content:    string;
  tags:       string[];
  metadata:   Record<string, unknown>;
  created_at: string;
}

export interface InboxCheckResult {
  processed: number;
  errors:    number;
  titles:    string[];
}

// ── Agent types ───────────────────────────────────────────────────────────────

export interface AgentParamSchema {
  key:         string;
  label:       string;
  type:        'text' | 'select';
  required?:   boolean;
  placeholder?: string;
  options?:    Array<{ value: string; label: string }>;
  default?:    string;
}

export interface AgentTypeInfo {
  key:          string;
  label:        string;
  description:  string;
  paramsSchema: AgentParamSchema[];
}

export interface AgentSchedule {
  frequency: 'daily' | 'weekly';
  hour?:     number;
}

export interface Agent {
  id:           string;
  name:         string;
  description:  string;
  type:         string;
  params:       Record<string, string>;
  trigger_type: 'manual' | 'scheduled';
  schedule:     AgentSchedule | null;
  active:       boolean;
  created_at:   string;
  updated_at:   string;
}

export interface AgentCreate {
  name:         string;
  description?: string;
  type:         string;
  params:       Record<string, string>;
  trigger_type: 'manual' | 'scheduled';
  schedule?:    AgentSchedule | null;
  active?:      boolean;
}

export interface AgentRun {
  id:               string;
  agent_id:         string;
  started_at:       string;
  finished_at:      string | null;
  status:           'running' | 'success' | 'error';
  output_neuron_id: string | null;
  output_title:     string | null;
  error_message:    string | null;
  similarity_note:  string | null;
  triggered_by:     string;
}

export interface AgentRunOutput {
  ok:               boolean;
  run_id:           string;
  title:            string;
  content:          string;
  kind:             string;
  skipped?:         boolean;
  similarity_note?: string | null;
}

// ── Résumé de vidéo longue ──────────────────────────────────────────────────

export interface VideoEstimate {
  ok:                              boolean;
  error?:                          string;
  duration_s:                      number;
  duration_label:                  string;
  chunk_count_estimate:            number;
  transcription_minutes_local:     number;
  transcription_minutes_groq:      number | null;
  summarization_minutes_estimate:  number;
  total_minutes_estimate_local:    number;
  groq_available:                  boolean;
  requires_confirmation:           boolean;
  confirmation_message:            string | null;
}

export type VideoJobStatus =
  | 'pending' | 'estimating' | 'downloading' | 'transcribing' | 'chunking'
  | 'summarizing' | 'synthesizing' | 'done' | 'error' | 'cancelled';

export interface VideoJob {
  id:                  string;
  url:                 string;
  title:               string | null;
  status:              VideoJobStatus;
  provider_whisper:    string;
  provider_synthesis:  string;
  resume_type:         string;
  duration_s:          number | null;
  current_step:        string;
  created_at:          string;
  updated_at:          string;
  error_message:       string | null;
  cancelled:            number | boolean;
  private:             number | boolean;
  neuron_id:           string | null;
  disk_bytes:          number;
  metadata:            Record<string, unknown>;
}

export interface VideoJobSegment {
  id:                 string;
  idx:                number;
  start_s:            number | null;
  end_s:              number | null;
  transcript_status:  string;
  summary_status:     string;
  error_message:      string | null;
  has_transcript:     boolean;
  has_summary:        boolean;
}

export interface VideoJobDetail {
  job:      VideoJob;
  segments: VideoJobSegment[];
}

export type OpenMontageStatus = 'NOT_INSTALLED' | 'PARTIAL' | 'READY_LOCAL' | 'BUSY' | 'ERROR';

export interface OpenMontageCapabilities {
  status:     OpenMontageStatus;
  python:     { available: boolean; version?: string | null };
  ffmpeg:     { available: boolean };
  remotion:   { available: boolean; version?: string | null; cwdVerified?: string | false };
  registry:   { available: boolean; toolCount: number };
  hyperframes: 'unavailable';
  piper:       'unavailable';
  gpuStack:    'unavailable';
}

export type OpenMontageResolution = '1920x1080' | '1080x1920' | '1080x1080';

export interface OpenMontageRenderRequest {
  title?:           string;
  subtitle?:        string;
  resolution:       OpenMontageResolution;
  fps:              24 | 25 | 30;
  durationSeconds:  number;
}

export interface OpenMontageJob {
  jobId:            string;
  status:           'running' | 'done' | 'failed' | 'cancelled';
  startedAt:        number;
  finishedAt:       number | null;
  elapsedMs:        number;
  error:            string | null;
  cancelled:        boolean;
  width:            number;
  height:           number;
  fps:              number;
  durationSeconds:  number;
  hasArtifact:      boolean;
  pid:              number | null;
}

export interface VideoSummaryCreate {
  url:                string;
  resumeType?:        string;
  whisperProvider?:   string;
  synthesisProvider?: string;
  private?:           boolean;
  title?:             string;
  duration_s?:        number;
}

export interface AgentOutput {
  id:         string;
  agent_id:   string;
  run_id:     string;
  title:      string;
  content:    string;
  kind:       string;
  created_at: string;
  consumed:   number;
}

export interface PrivacyViolation {
  id:                number;
  occurred_at:       string;
  function_called:   string;
  provider_targeted: string;
}

export interface PrivacyTestProviderResult {
  provider:         string;
  blocked_private:  boolean;
  passed_neutral:   boolean;
}

export interface PrivacyTestResult {
  ok:      boolean;
  results: PrivacyTestProviderResult[];
}

// ── Connectors (YouTube / Google Drive / OneDrive) ──────────────────────────

export type ConnectorId = 'youtube' | 'google_drive' | 'onedrive' | 'dropbox' | 'github' | 'notion' | 'google_calendar' | 'outlook_calendar';

export interface ConnectorState {
  provider:            ConnectorId;
  id:                  ConnectorId;
  label:                string;
  category:             string;
  status:               'active' | 'unsupported';
  capabilities:         string[];
  authType:             string;
  privacyPolicy:        string;
  clientFamily:         string | null;
  connected:            boolean;
  account_label:        string | null;
  scopes:               string[];
  auto_sync:            boolean;
  last_sync_at:         string | null;
  last_sync_status:     string | null;
  last_sync_error:      string | null;
  synced_items_count:   number;
  client_configured:    boolean;
}

export interface ConnectorsListResult {
  connectors: ConnectorState[];
}

export interface MemorySettings {
  enabled:                  boolean;
  learn_from_searches:      boolean;
  learn_from_neurons:       boolean;
  learn_from_corrections:   boolean;
  budget:                   'low' | 'normal' | 'extended';
}

export interface MemoryItem {
  id:            string;
  text:          string;
  tier:          'long_term' | 'episodic';
  category:      string;
  source:        string;
  privacy:       boolean;
  egress_policy: string;
  importance:    number;
  confidence:    number;
  usage_count:   number;
  last_used_at:  string | null;
  created_at:    string;
}

export interface MemoryItemsResult {
  long_term:       MemoryItem[];
  episodic:        MemoryItem[];
  episodic_total:  number;
  budget:          { maxMemories: number; maxChunks: number };
}

export interface MemoryPreviewResult {
  selected: Array<{ id: string; text: string; tier: 'long_term' | 'episodic'; privacy: boolean; egressPolicy: string }>;
  budget:   { maxMemories: number; maxChunks: number };
}

export interface Notebook {
  id:            string;
  title:         string;
  description:   string;
  privacy:       boolean;
  egress_policy: string;
  created_at:    string;
  updated_at:    string;
  source_count?: number;
}

export interface NotebookSource {
  id:            string;
  notebook_id:   string;
  source_type:   string;
  source_id:     string;
  title:         string;
  provenance:    string;
  privacy:       boolean;
  egress_policy: string;
  added_at:      string;
}

export interface NotebookCitation {
  ref:         number;
  chunkId:     string;
  sourceId:    string;
  sourceTitle: string;
  passage:     string;
}

export interface NotebookAskResult {
  answer:      string;
  citations:   NotebookCitation[];
  chunks_used: number;
}

export interface NotebookSummaryResult {
  content:      string;
  cached:       boolean;
  sourceCount:  number;
}

// ── Notebook NB-2 — raw documents (strict local) ─────────────────────────────
export type NotebookDocStatus =
  | 'QUEUED' | 'SCANNING' | 'PARSING' | 'CHUNKING' | 'INDEXING' | 'READY' | 'FAILED' | 'SECURITY_BLOCKED';

export interface NotebookDocument {
  documentId:       string;
  sourceId:         string;
  title:            string;
  mimeType:         string;
  hash:             string;
  size:             number;
  language:         string | null;
  createdAt:        string;
  updatedAt:        string;
  currentVersionId: string | null;
  status:           NotebookDocStatus;
  trustLevel:       string;
  errorCode:        string | null;
  retention?:       'KEEP' | 'MANUAL' | 'DELETE_AFTER' | 'SESSION_ONLY';
  expiresAt?:       string | null;
}

export type NotebookVectorStatusName = 'READY' | 'VECTOR_PARTIAL' | 'VECTOR_STALE' | 'VECTOR_UNAVAILABLE' | 'NOT_USED';
export interface NotebookVectorStatus {
  status:       NotebookVectorStatusName;
  total:        number;
  compatible:   number;
  incompatible: number;
  missing:      number;
  model?:       string;
  embedVersion?: string;
  needsReindex: boolean;
}

export type NotebookRetention = 'KEEP' | 'MANUAL' | 'DELETE_AFTER' | 'SESSION_ONLY';
export type NotebookTrustFilter = 'all' | 'trusted' | 'user_authored';

export interface NotebookRetrievalOptions {
  trustFilter?:       NotebookTrustFilter;
  documentIds?:       string[];
  includeHistorical?: boolean;
  profile?:           'precise' | 'broad';
}

export interface NotebookSourceConflict {
  type:     'POLARITY' | 'NUMERIC' | 'VERSION';
  heuristic: boolean;
  a: { citationId: number | null; chunkId: string; sourceId: string; sourceTitle: string; documentVersion: number; importedAt: string | null; page: number | null; excerpt: string };
  b: { citationId: number | null; chunkId: string; sourceId: string; sourceTitle: string; documentVersion: number; importedAt: string | null; page: number | null; excerpt: string };
}

export interface NotebookDocAnswer {
  strict_local:    boolean;
  status:          'ANSWERED' | 'NO_RELEVANT_SOURCE' | 'OUTSIDE_NOTEBOOK';
  outside_notebook: boolean;
  answer:          string;
  citations:       NotebookDocCitation[];
  uncertainties:   Array<{ code: string; message: string }>;
  source_conflicts: NotebookSourceConflict[];
  sources_used:    Array<{ sourceId: string; sourceTitle: string; documentVersion: number; trustLevel: string; assertionType: string; chunksUsed: number; cited: boolean }>;
  retrieval_mode:  'HYBRID' | 'FTS_ONLY' | 'NONE';
  mode:            string;
  vector_status:   NotebookVectorStatusName;
  confidence:      'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  chunks_used:     number;
}

// ── Notebook NB-4 — imported AI histories (strict local; provider formats are synthetic-tested only) ──
export type AiProvider = 'CHATGPT' | 'GEMINI' | 'CLAUDE' | 'UNKNOWN';
export type AiRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL' | 'UNKNOWN';
export type AiImportStatus = 'QUEUED' | 'SCANNING' | 'PARSING' | 'NORMALIZING' | 'SECURITY_SCAN' | 'INDEXING' | 'DISTILLING' | 'REVIEW_REQUIRED' | 'READY' | 'FAILED' | 'CANCELLED';

export interface AiImportCounts {
  files: number; conversations: number; conversationsNew: number; conversationsUpdated: number; conversationsUnchanged: number; invalid: number;
  messages: number; messagesNew: number; messagesDuplicate: number; messagesBlocked: number; messagesRedacted: number;
  attachments: number; attachmentsAvailable: number; attachmentsMissing: number; attachmentsUnsupported: number; attachmentsBlocked: number;
  chunks: number; vectorFailed: boolean; blockedEntries: number; declaredProvider?: string;
}
export interface AiSecretFinding { kind: string; severity: string; count: number }
export interface AiImportPreview {
  previewId: string | null; size: number; adapter: string; provider: AiProvider; providerVerified: boolean; detection: string;
  counts: AiImportCounts; findings: AiSecretFinding[]; dateRange: { from: string | null; to: string | null }; titles: string[];
  blockedEntries: Array<{ name: string; reason: string }>; syntheticCoverage: boolean; needsConfirm: boolean; fileHash: string;
}
export interface AiImport {
  importId: string; provider: AiProvider; adapter: string; providerVerified: boolean; sourceName: string; size: number; status: AiImportStatus;
  distillStatus: string; errorCode: string | null; secretPolicy: string; counts: Partial<AiImportCounts>; findings: AiSecretFinding[];
  createdAt: string; updatedAt: string; retention: string | null; expiresAt: string | null;
}
export interface AiConversation {
  conversationId: string; importId: string; provider: AiProvider; providerVerified: boolean; title: string; createdAt: string | null;
  updatedAt: string | null; messageCount: number; language: string | null;
}
export interface AiMessage {
  messageId: string; role: AiRole; content: string; createdAt: string | null; trustLevel: string; onMainPath: boolean; isCurrent: boolean;
  provider: AiProvider; originalId: string | null; flags: string[]; codeLangs: string[];
  attachments?: Array<{ name: string; status: string; mime: string; size: number | null }>;
}
export interface AiHistoryHit {
  chunkId: string; conversationId: string; conversationTitle: string; importId: string; provider: AiProvider; providerLabel: string; providerVerified: boolean;
  role: AiRole; trustLevel: string; assertionType: string; speaker: string; date: string | null; messageIds: string[]; branch: boolean;
  injectionFlags: string[]; score: number; text: string;
}
export interface AiHistoryCitation {
  type: 'AI_HISTORY_MESSAGE'; ref: number; chunkId: string; importId: string; conversationId: string; conversationTitle: string; provider: AiProvider; providerLabel: string;
  role: AiRole; trustLevel: string; assertionType: string; verification: string; messageIds: string[]; date: string | null; speaker: string; passage: string; branch: boolean;
}
export interface AiHistoryAnswer {
  status: 'ANSWERED' | 'NO_RELEVANT_SOURCE'; answer: string; citations: AiHistoryCitation[]; uncertainties: Array<{ code: string; message: string }>;
  sourceConflicts: NotebookSourceConflict[]; retrievalMode: string; vectorStatus: string; confidence: string; voices?: Array<{ role: AiRole; provider: AiProvider; speaker: string }>;
}
export interface AiCitationPreview {
  chunkId: string; conversationTitle: string; providerLabel: string; providerVerified: boolean; role: AiRole; trustLevel: string; assertionType: string; date: string | null; text: string; branch: boolean;
  messages: Array<{ messageId: string; role: AiRole; createdAt: string | null; content: string; trustLevel: string; onMainPath: boolean }>;
  attachments: Array<{ name: string; status: string; indexed: boolean }>;
}
export interface AiCandidate {
  candidateId: string; type: string; statement: string; trustLevel: string; assertionType: string; confidence: number; status: 'CANDIDATE' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
  method: string; statedAt: string | null; lastEvidenceAt: string | null; edited: boolean; orphaned: boolean; promotion: string; evidenceCount?: number; conversationCount?: number;
}
export interface AiCandidateDetail extends AiCandidate {
  evidence: Array<{ messageId: string; conversationId: string; conversationTitle: string; provider: AiProvider; role: AiRole; quote: string; ts: string | null }>;
  links: Array<{ candidateId: string; relatedId: string; kind: string; ambiguous: boolean; detail: string }>;
}
export interface AiHistoryFilters { provider?: AiProvider; role?: AiRole; from?: string; to?: string; importIds?: string[]; conversationIds?: string[]; trustLevels?: string[]; profile?: 'precise' | 'broad' }

// ── NB-5 — DOCTEUR MEMORY (approved memory only; every item was explicitly approved by a human) ─────────
export type MemoryStatus = 'APPROVED' | 'SUPERSEDED' | 'REVOKED' | 'ARCHIVED';
export type MemoryScopeKind = 'GLOBAL' | 'PROJECT' | 'NOTEBOOK';
export type MemorySensitivity = 'NORMAL' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
export type MemoryRetention = 'KEEP' | 'MANUAL' | 'DELETE_AFTER' | 'SESSION_ONLY';
export interface MemoryScope { kind: MemoryScopeKind; projectId: string | null; notebookId: string | null }
export interface MemoryItem {
  memoryId: string; statement: string; type: string; status: MemoryStatus; scope: MemoryScope; scopeKind: MemoryScopeKind; projectId: string | null; notebookId: string | null;
  confidence: number; trustLevel: string; sensitivity: MemorySensitivity; createdAt: string; updatedAt: string; approvedAt: string; effectiveFrom: string; effectiveUntil: string | null;
  supersededBy: string | null; sourceKind: 'CANDIDATE' | 'MANUAL'; sourceCandidateId: string | null; originalStatement: string | null; editedBeforeApproval: boolean; approvalSource: string;
  provenance: { origin?: string; evidenceCount?: number; providers?: string[] }; injectionFlags: string[]; version: number; retention: MemoryRetention; expiresAt: string | null; needsReview: boolean;
  provenanceStatus: 'OK' | 'MANUAL' | 'MISSING'; score?: number;
}
export interface MemoryEvidence { kind: string; ref: string; sourceId: string | null; conversationId: string | null; provider: string | null; role: string | null; trustLevel: string | null; quote: string; ts: string | null; status: 'OK' | 'SOURCE_MISSING' }
export interface MemoryRevision { revisionId: string; version: number; action: string; oldStatement: string | null; newStatement: string | null; oldStatus: string | null; newStatus: string | null; reason: string | null; at: string }
export interface MemoryConflict { conflictId: string; memoryA: string; memoryB: string; kind: string; detail: string; status: string; resolution: string | null; detectedAt: string; a: MemoryItem | null; b: MemoryItem | null }
export interface MemorySuggestion { suggestionId: string; newId: string; oldId: string; ambiguous: boolean; detail: string; status: string; createdAt: string; newMemory: MemoryItem | null; oldMemory: MemoryItem | null }
export interface MemoryProject { projectId: string; name: string }
export interface MemoryWriteInput {
  type?: string; scope?: { kind: MemoryScopeKind; projectId?: string | null; notebookId?: string | null }; statement?: string; sensitivity?: MemorySensitivity; retention?: MemoryRetention; retentionDuration?: string;
  confirmGlobal?: boolean; confirmSensitive?: boolean; allowDuplicate?: boolean; secretPolicy?: 'block' | 'redact'; expectedVersion?: number;
}
export interface MemoryUsedRef { marker: string; memoryId: string; type: string; scope: MemoryScope; status: MemoryStatus; statement: string }
export interface MemoryAnswer { requestId: string; answer: string; memoryUsed: MemoryUsedRef[]; memoryCitations: Array<{ marker: string; memoryId: string; statement: string }>; conflicts: Array<{ conflictId: string; kind: string; memoryA: string; memoryB: string; detail: string }>; notice: string | null; retrievalMode: string; vectorStatus: string; authority: 'CONTEXT_ONLY' }
export interface MemoryStatusInfo { projects: MemoryProject[]; counts: { approved: number; superseded: number; revoked: number; archived: number }; vector: { total: number; missing: number; incompatible: number; needsReindex: boolean }; constants: { MEMORY_TYPES: string[]; MAX_STATEMENT_CHARS: number } }
export class MemoryApiError extends Error {
  code: string; extra: Record<string, unknown>;
  constructor(message: string, code: string, extra: Record<string, unknown> = {}) { super(message); this.name = 'MemoryApiError'; this.code = code; this.extra = extra; }
}
async function memoryJson<T>(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 60_000): Promise<T> {
  const res = await apiFetch(`/api/docteur-memory${path}`, { method: init.method ?? 'GET', ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}) }, timeoutMs);
  const body = await res.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!res.ok) { const { error, code, ...extra } = body as { error?: string; code?: string } & Record<string, unknown>; throw new MemoryApiError(error ?? `Mémoire HTTP ${res.status}`, code ?? 'MEMORY_HTTP', extra); }
  return body;
}

export interface NotebookCitationPreview {
  chunkId: string; sourceId: string; sourceTitle: string; documentVersion: number; versionId: string;
  page: number | null; headingPath: string[]; startOffset: number | null; endOffset: number | null; hash: string;
  trustLevel: string; assertionType: string; superseded: boolean; importedAt: string | null; text: string;
}

export interface NotebookDocImportResult {
  documentId:  string;
  versionId:   string;
  duplicate:   boolean;
  status:      NotebookDocStatus;
  errorCode?:  string;
  findings?:   Array<{ kind: string; severity: string; count: number; lines: number[] }>;
  requiresConfirmation?: boolean;
  vectorStatus?: string;
}

export interface NotebookDocSearchHit {
  chunkId:         string;
  sourceId:        string;
  sourceTitle:     string;
  documentVersion: number;
  page:            number | null;
  headingPath:     string[];
  trustLevel:      string;
  score:           number;
  ftsRank:         number | null;
  vectorRank:      number | null;
  injectionFlags:  string[];
  text:            string;
}

export interface NotebookDocCitation {
  ref:             number;
  chunkId:         string;
  sourceId:        string;
  sourceTitle:     string;
  documentVersion: number;
  versionId:       string;
  page:            number | null;
  headingPath:     string[];
  trustLevel:      string;
  superseded:      boolean;
  passage:         string;
  assertionType?:  string;
  startOffset?:    number | null;
  endOffset?:      number | null;
}

export interface InstalledBrowser {
  id:    string;
  label: string;
  path:  string | null;
}

export interface BrowserSettings {
  selected:   string;
  customPath: string | null;
}

export interface SherlockInstallState {
  status:      'not_installed' | 'installed' | 'error';
  version:     string | null;
  installedAt: number | null;
  lastError:   string | null;
  pinnedSha?:  string;
}

export interface SherlockSearchResult {
  site:   string;
  url:    string;
  username: string;
  profileUrl: string;
  status: 'found' | 'absent' | 'invalid' | 'error';
  responseTime: number | null;
  metadata?: { source?: string; untrusted?: boolean; pinnedSha?: string };
}

export interface SherlockJob {
  id:        string;
  operation: string;
  status:    string;
  username: string;
  duration: number;
  current: number;
  total: number;
  summary:   { results?: SherlockSearchResult[]; error?: string; exitCode?: number; found?: number; absent?: number; errors?: number } | null;
}

export interface VoiceSettings {
  enabled:             boolean;
  whisperMode:         'local' | 'groq';
  porcupineAccessKey:  string | null;
  hasPorcupineModel:   boolean;
}

export interface BackupListResult {
  backups: BackupEntry[];
  count: number;
}

export interface FileCompetenceInfo {
  id: string;
  label: string;
  cloud: boolean;
}

// ── Skills (compétences à la demande) ────────────────────────────────────────

export interface SkillInstructionHistory {
  instruction: string;
  version:     number;
  saved_at:    string;
}

export interface Skill {
  id:                  string;
  name:                string;
  description:         string;
  instruction:         string;
  input_type:          'text' | 'neuron' | 'file';
  output_type:         'display' | 'neuron' | 'file';
  output_kind:         string;
  model:               'local' | 'cloud';
  private:             boolean;
  active:              boolean;
  version:             number;
  instruction_history: SkillInstructionHistory[];
  run_count:           number;
  last_run_at:         string | null;
  created_at:          string;
  updated_at:          string;
}

export interface SkillRun {
  id:            string;
  skill_id:      string;
  input_preview: string;
  output:        string;
  model_used:    string | null;
  latency_ms:    number | null;
  started_at:    string;
  finished_at:   string | null;
  status:        'running' | 'done' | 'error';
  error_message: string | null;
}

export interface SkillsListResult {
  skills: Skill[];
  count:  number;
  max:    number;
}

export interface SkillRunResult {
  run_id:     string;
  output:     string;
  model_used: string;
  latency_ms: number;
}

export interface SkillGenerateResult {
  instruction:    string;
  suggested_name: string;
  model_used:     string;
}

// ── Générateur de prompts (indépendant des neurones) ──────────────────────────

export type PromptOutcome = 'untested' | 'worked' | 'half' | 'broken';
export type PromptKeptVersion = 'draft' | 'reviewed' | null;

export interface GeneratedPrompt {
  id:                 string;
  request:            string;
  draft_model:        string;
  draft_provider:     string;
  draft_text:         string;
  review_model:       string;
  review_provider:    string;
  reviewed_text:      string;
  changes_explained:  string;
  unchanged:           boolean;
  kept_version:        PromptKeptVersion;
  outcome:             PromptOutcome;
  is_template:         boolean;
  created_at:          string;
  updated_at:          string;
}

export interface PromptGeneratorModelOption {
  id:    string;
  provider: string;
  label: string;
  level_label?: string;
}

export interface PromptGeneratorModelsResult {
  local:  PromptGeneratorModelOption[];
  cloud:  PromptGeneratorModelOption[];
  strict_local_mode: boolean;
}

export interface PromptGeneratorSettings {
  default_draft_model:     string | null;
  default_draft_provider:  string | null;
  default_review_model:    string | null;
  default_review_provider: string | null;
}

export interface PromptDestination {
  id:          string;
  name:        string;
  url:         string;
  category:    string;
  urlTemplate: string;
  favorite:    boolean;
  order:       number;
}

export interface PromptSendEvent {
  id:                   string;
  generated_prompt_id:  string;
  destination_id:       string;
  destination_name:     string;
  prefill_used:         boolean;
  created_at:           string;
}

export interface FileOriginalSummary {
  id: string;
  original_name: string;
  stored_name: string;
  extension: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  checksum: string;
  metadata: Record<string, unknown>;
  treatments_count: number;
  result_count?: number;
  last_result_at?: string | null;
  download_url?: string;
  detail_url?: string;
  results_url?: string;
  file_path?: string;
}

export interface FileResultSummary {
  id: string;
  original_id: string;
  competence: string;
  result_kind: string;
  original_name: string;
  stored_name: string;
  extension: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  checksum: string;
  path: string;
  cloud_allowed: boolean;
  metadata: Record<string, unknown>;
  download_url?: string;
  original_detail_url?: string;
}

export interface FilePreviewSpreadsheetSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  columns: string[];
  sampleRows: string[][];
}

export interface FilePreviewResult {
  kind: 'text' | 'json' | 'spreadsheet';
  text?: string;
  summary?: { sheetCount: number; sheets: FilePreviewSpreadsheetSheet[] };
  mimeType?: string;
}

export interface FileDetailResult {
  original: FileOriginalSummary;
  history: FileResultSummary[];
  preview?: FilePreviewResult;
}

export interface FilesIndexResult {
  paths: { root: string; originals: string; results: string };
  originals: FileOriginalSummary[];
  results: FileResultSummary[];
  competences: FileCompetenceInfo[];
}

// ── Todo ─────────────────────────────────────────────────────────────────────

export interface TodoItem {
  id:             string;
  type:           'capture' | 'task';
  url?:           string | null;
  title?:         string | null;
  note?:          string | null;
  detected_kind?: string | null;
  video_count?:   number | null;
  status:         'pending' | 'done' | 'failed';
  priority:       number;
  result_page_id?: string | null;
  error?:         string | null;
  created_at:     string;
  done_at?:       string | null;
}

export interface BackupExport {
  version: string;
  exported_at: string;
  neurons_count: number;
  neurons: Array<{
    id: string; kind: string; title: string; content: string; metadata: Record<string, unknown>;
    blocks?: Block[];
    createdAt?: number; updatedAt?: number; links?: string[]; color?: string; tags?: string[]; private?: boolean;
  }>;
  links?: Array<{ from: string; to: string }>;
}

export type YouTubeMediaType = 'VIDEO' | 'SHORT' | 'STREAM';
export type YouTubeSourceTab  = 'videos' | 'shorts' | 'streams' | 'playlist';
export type YouTubeDiscoveryMode =
  | 'CHANNEL_ALL_MEDIA' | 'CHANNEL_VIDEOS_ONLY' | 'CHANNEL_SHORTS_ONLY' | 'CHANNEL_STREAMS_ONLY'
  | 'PLAYLIST_ONLY' | 'SINGLE_VIDEO' | 'SINGLE_SHORT' | 'CHANNEL_LIVE';

export interface PlaylistVideo {
  id:    string;
  title: string;
  url:   string;
  thumbnail?: string;
  channel?: string;
  duration?: number;
  uploadDate?: string;
  timestamp?: number;
  /** Smart Discovery V2 typing */
  sourceChannel?: string;
  sourceTab?: YouTubeSourceTab;
  sourceTabs?: YouTubeSourceTab[];
  mediaType?: YouTubeMediaType;
}

export type YouTubeDiscoveryEvent =
  | { type: 'start'; input: string; at: number }
  | { type: 'mode'; mode: YouTubeDiscoveryMode; kind: string; handle: string | null; canonicalUrl: string; sources: YouTubeSourceTab[] }
  | { type: 'phase_start'; tab: YouTubeSourceTab; index: number; total: number }
  | { type: 'progress'; tab: YouTubeSourceTab; pages: number; count: number; total: number; elapsedMs: number }
  | { type: 'items_batch'; tab: YouTubeSourceTab; items: PlaylistVideo[]; total: number }
  | { type: 'phase_done'; tab: YouTubeSourceTab; count: number; available: boolean; pages: number; durationMs: number; total: number }
  | { type: 'done'; mode: YouTubeDiscoveryMode; total: number; counts: Record<string, number>; duplicates: number; durationMs: number;
      channel: YouTubeChannelInfo; merged?: Array<Pick<PlaylistVideo, 'id' | 'mediaType' | 'url' | 'sourceTab' | 'sourceTabs'>> }
  | { type: 'cancelled'; total: number }
  | { type: 'error'; name?: string; code?: string; message: string };

export interface YouTubeChannelInfo { handle: string | null; url: string; title: string; uploader: string; id: string }

export interface YouTubeDiscoveryResult {
  mode: YouTubeDiscoveryMode;
  channel: YouTubeChannelInfo;
  items: PlaylistVideo[];
  total: number;
  counts: Record<string, number>;
  duplicates: number;
  durationMs: number;
}

/** YouTube Multi-Channel V1: one job per pasted line, discovered by a bounded server-side FIFO queue. */
export type YouTubeChannelJobStatus =
  | 'PENDING' | 'VALIDATING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DUPLICATE';

export interface YouTubeChannelJob {
  id: string;
  /** 0-based line number in the paste */
  index: number;
  input: string;
  normalizedUrl: string | null;
  mode: YouTubeDiscoveryMode | null;
  handle: string | null;
  channelId: string | null;
  channelName: string | null;
  status: YouTubeChannelJobStatus;
  phases: Array<{ tab: YouTubeSourceTab; status: 'pending' | 'running' | 'done' | 'unavailable'; count: number }>;
  currentTab: YouTubeSourceTab | null;
  pages: number;
  itemsFound: number;
  message: string | null;
  error: { code: string; message: string; reason?: string } | null;
  duplicateOf: string | null;
  retryable: boolean;
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface YouTubeChannelBatchSummary {
  total: number; waiting: number; running: number; completed: number; failed: number; cancelled: number; duplicate: number;
  /** items found by the completed channels */
  items: number;
  active: boolean;
}

export interface YouTubeChannelBatch {
  batchId: string;
  createdAt: number;
  concurrency: number;
  summary: YouTubeChannelBatchSummary;
  jobs: YouTubeChannelJob[];
}

export interface YouTubeChannelJobResult {
  job: YouTubeChannelJob;
  mode: YouTubeDiscoveryMode;
  channel: YouTubeChannelInfo;
  items: PlaylistVideo[];
  counts: Record<string, number>;
  duplicates: number;
  durationMs: number;
}

export interface PlaylistInfo {
  title:       string;
  uploader:    string;
  playlistId:  string;
  video_count: number;
  videos:      PlaylistVideo[];
  source_type?: 'videos' | 'shorts' | 'short';
}

export interface ImportResult {
  ok: boolean;
  indexed: number;
  total: number;
  reconstructedBlocks?: number;
  errors: Array<{ id: string; title: string; error: string }>;
}

export interface CaptureResult {
  parent: CaptureNeuron | null;
  child: CaptureNeuron;
  latency_ms?: number;
}

// ── Module-level availability cache ───────────────────────────────────────

let _available  = false;
let _lastCheck: Date | null = null;

// ── Connection-error notifier ───────────────────────────────────────────────
// The browser throws a plain TypeError ("Failed to fetch") for both a
// connection-refused (nothing listening on the port) and a CORS rejection —
// there is no server response to inspect. Without this, those failures were
// silent unless the calling code happened to catch-and-toast itself (e.g. a
// leftover Vite process bumping the dev server to a port cortex-server's CORS
// allowlist doesn't recognize). Registered once by the UI (App.tsx) so every
// call funnelled through apiFetch surfaces a visible message for free.
type ConnErrorListener = (message: string) => void;
let _onConnError: ConnErrorListener | null = null;
export function onConnectionError(cb: ConnErrorListener): void {
  _onConnError = cb;
}
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

// ── Internal fetch helpers ─────────────────────────────────────────────────

async function fetchTimeout(url: string, opts: RequestInit, timeoutMs: number | null = TIMEOUT): Promise<Response> {
  const ctrl  = new AbortController();
  const timer = timeoutMs === null ? null : setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const signal = opts.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([opts.signal, ctrl.signal])
      : ctrl.signal;
    return await fetch(url, { ...opts, signal });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function apiFetch(path: string, opts: RequestInit = {}, timeoutMs: number | null = TIMEOUT): Promise<Response> {
  const url = `${BASE}${path}`;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 2 ** attempt * 200)); // 400, 800 ms
    }
    try {
      return await fetchTimeout(url, opts, timeoutMs);
    } catch (e) {
      lastErr = e;
      // Don't retry on intentional abort
      if (e instanceof Error && e.name === 'AbortError') throw e;
    }
  }
  if (isNetworkError(lastErr)) {
    _onConnError?.('Connexion au serveur refusée. Vérifie que Docteur est lancé sur le bon port.');
  }
  throw lastErr;
}

/** YouTube multi-channel queue calls: JSON in/out; errors keep the server code (BATCH_NOT_FOUND, JOB_ALREADY_FINISHED…) and HTTP status. */
async function channelQueueCall<T>(path: string, init: RequestInit): Promise<T> {
  const res = await apiFetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
  if (!res.ok) {
    const error = new Error(body.message || body.error || `HTTP ${res.status}`) as Error & { code?: string; status?: number };
    error.code = body.error;
    error.status = res.status;
    throw error;
  }
  return body as T;
}

function parseWhisperSseChunks(parts: string[], onProgress: (p: WhisperProgress) => void): DeepCaptureResult | null {
  for (const part of parts) {
    const line = part.replace(/^data:\s*/, '').trim();
    if (!line) continue;
    let evt: WhisperProgress;
    try { evt = JSON.parse(line) as WhisperProgress; }
    catch { continue; }
    if (evt.error) throw new Error(evt.error);
    if (evt.done && evt.result) return evt.result;
    onProgress(evt);
  }
  return null;
}

// ── Image URL helper (absolute, points to cortex-server on port 3001) ────────
export function getImageUrl(id: string): string {
  return `${BASE}/api/image/${encodeURIComponent(id)}`;
}

// Le backend renvoie des chemins relatifs (`/api/audio-player/file?...`) —
// les résoudre contre BASE plutôt que l'origine du frontend (peuvent différer en dev).
export function resolveApiUrl(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BASE}${pathOrUrl}`;
}

// ── Vision (image analysis, 100% local) ──────────────────────────────────────

export interface VisionStatus {
  model:     string;
  installed: boolean;
  gpu_busy?: boolean;
}

export interface VisionAnalyzeResult {
  ok:                 boolean;
  answer?:            string;
  model_used?:        string;
  latency_ms?:        number;
  error?:             string;
  model_installed?:   boolean;
  gpu_busy?:           boolean;
  fallback_suggested?: boolean;
}

// ── Conversation mode (chat, 100% local) ─────────────────────────────────────

export interface ChatConversation {
  id:         string;
  title:      string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id:              string;
  conversation_id: string;
  role:            'user' | 'assistant';
  content:         string;
  created_at:      string;
}

export interface ChatSource {
  id:      string;
  title:   string;
  kind:    string;
  private: boolean;
}

export interface ChatStatus {
  model:     string;
  installed: boolean;
  gpu_busy:  boolean;
}

export interface ChatSendResult {
  ok:              boolean;
  answer?:         string;
  suggested_fact?: string | null;
  model_used?:     string;
  sources?:        ChatSource[];
  latency_ms?:     number;
  error?:          string;
  model_installed?: boolean;
  gpu_busy?:        boolean;
}

export interface PreferenceFact {
  id:         string;
  fact:       string;
  created_at: string;
}

// ── Candidature — bibliothèque de prompts sauvegardés ──────────────────────────

export interface CandidatureSavedPrompt {
  id:            string;
  name:          string;
  prompt_text:   string;
  order_index:   number;
  last_used_at:  string | null;
  created_at:    string;
  updated_at:    string;
}

// Prompt Generator — bibliothèque de modèles ("Modèles"). Same shape/pattern
// as CandidatureSavedPrompt above, plus category/description. The 5 templates
// Docteur ships with are seeded server-side as ordinary rows (no is_system
// flag) — editing/deleting one behaves exactly like a user-created template.
export interface PromptTemplate {
  id:            string;
  name:          string;
  category:      string;
  description:   string;
  prompt_text:   string;
  order_index:   number;
  last_used_at:  string | null;
  created_at:    string;
  updated_at:    string;
}

// ── Kiwix (archives ZIM) ──────────────────────────────────────────────────────

export interface KiwixSettings {
  kiwixServePath: string | null;
  archivesFolder: string;
  port:           number;
  autoDetect:     boolean;
  binaryFound:    boolean;
  kiwixToolsUrl:  string;
}

export interface KiwixArchive {
  name:      string;
  fileName:  string;
  path:      string;
  sizeBytes: number;
}

export interface KiwixArchivesResult {
  folder:     string;
  archives:   KiwixArchive[];
  totalBytes: number;
}

export interface KiwixStatus {
  running:            boolean;
  port:               number | null;
  archives:           KiwixArchive[];
  lastError:          string | null;
  pid:                number | null;
  externallyManaged?: boolean;
}

export interface KiwixStartResult {
  ok:              boolean;
  error?:          string;
  message?:        string;
  port?:           number;
  archives?:       KiwixArchive[];
  alreadyRunning?: boolean;
}

export interface KiwixSuggestion {
  label: string;
  value: string;
  path:  string;
  kind:  string;
}

export interface KiwixSearchResult {
  title:    string;
  path:     string;
  snippet:  string;
  bookName: string;
}

export interface KiwixArticleContent {
  html:  string;
  title: string;
  text:  string;
  book:  string;
  path:  string;
}

export interface KiwixCatalogEntry {
  id:          string;
  name:        string;
  title:       string;
  description: string;
  language:    string;
  updated:     string;
  sizeBytes:   number | null;
  downloadUrl: string | null;
}

export type KiwixSearchScope = 'neurones' | 'archives' | 'les_deux';

export interface KiwixDownloadProgress {
  type:       'status' | 'progress' | 'done' | 'error';
  message?:   string;
  downloaded?: number;
  total?:     number;
  percent?:   number | null;
  filePath?:  string;
  fileName?:  string;
}

// ── Lecteur audio (lo-fi ambiant) ─────────────────────────────────────────────

export interface AudioRadioPreset {
  id:   string;
  name: string;
  url:  string;
}

export interface AudioCustomStream {
  name: string;
  url:  string;
}

export interface AudioPlayerSettings {
  localFolder:     string | null;
  customStreams:   AudioCustomStream[];
  source:          'local' | 'radio';
  selectedRadioId: string;
  presets:         AudioRadioPreset[];
}

export interface AudioLocalFile {
  name: string;
  url:  string;
}

export interface AudioLocalFilesResult {
  folder: string | null;
  files:  AudioLocalFile[];
  error?: string;
}

// ── Module Professeur ────────────────────────────────────────────────────

export type TeacherRegister = 'enfant' | 'debutant' | 'standard' | 'expert' | 'socratique';
export type LearningPathStatus = 'planning' | 'active' | 'completed' | 'abandoned';
export type LearningStepStatus = 'pending' | 'active' | 'done';

export interface TeacherSettings {
  model: string; // 'local' | 'groq:<model-id>'
  defaultRegister: TeacherRegister;
}

export interface TeacherQuotaInfo {
  model: string;
  provider: 'local' | 'groq';
  used_today: number | null;
  limit: number | null;
  remaining: number | null;
  unlimited_local: boolean;
}

export interface TeacherLocalModelOption {
  id: string;
  size_bytes: number | null;
  size_label: string | null;
}

export interface TeacherGroqModelOption {
  id: string;
  configured: boolean;
  disabled_reason: string | null;
  used_today: number | null;
  limit: number | null;
  remaining: number | null;
}

// Même forme que TeacherGroqModelOption — Gemini et OpenRouter n'ont pas de
// limite quotidienne connue/vérifiée dans ce codebase, donc used_today/limit/
// remaining sont toujours null pour ces deux providers (pas de chiffre inventé).
export type TeacherCloudModelOption = TeacherGroqModelOption;

export interface TeacherCloudProviderModels {
  available: boolean;
  configured: boolean;
  models: TeacherCloudModelOption[];
}

export interface TeacherAvailableModels {
  strict_local_mode: boolean;
  local: { available: boolean; reason: string | null; models: TeacherLocalModelOption[] };
  cloud: {
    groq: TeacherCloudProviderModels;
    gemini: TeacherCloudProviderModels;
    openrouter: TeacherCloudProviderModels;
  };
}

export interface TeacherValidateModelResult {
  ok: boolean;
  error?: string;
}

export interface LearningPlanStep {
  title: string;
  summary: string;
}

// Fixed, safe vocabulary for why a Teacher call answered from the local
// model instead of the cloud provider that was actually configured — never
// the raw provider error text (see teacher.js's fallbackReasonFromError).
export type TeacherFallbackReasonCode = 'strict_local' | 'provider_unavailable' | 'timeout' | 'network_error' | 'unknown';

export interface LearningPath {
  id: string;
  subject: string;
  register: TeacherRegister;
  teacher_model: string;
  status: LearningPathStatus;
  plan: LearningPlanStep[];
  current_step_index: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  recap_neuron_id: string | null;
}

export interface ComprehensionExchange {
  question: string;
  answer: string;
  evaluation: string;
  reask: string | null;
}

export interface LearningPathStep {
  id: string;
  path_id: string;
  step_index: number;
  title: string;
  content: string;
  status: LearningStepStatus;
  comprehension_check: ComprehensionExchange[];
  created_at: string;
  updated_at: string;
}

export interface ReviewItem {
  id: string;
  source_type: 'path_step' | 'neuron';
  source_id: string;
  question: string;
  answer_hint: string;
  ease_factor: number;
  interval_days: number;
  next_review_at: string;
  last_reviewed_at: string | null;
  review_count: number;
  success_count: number;
  created_at: string;
}

export interface TeacherStats {
  total_items: number;
  due_now: number;
  total_attempts: number;
  success_rate: number;
  subjects_studied: number;
  paths_in_progress: number;
  paths_planning: number;
  paths_completed: number;
  paths_abandoned: number;
}

// ── [Professeur V2 — PROF-2] dual-track (théorie + pratique) — additive types, existing ones untouched ──────────
export type TeacherTrackName = 'theory' | 'practice';
export type TeacherTrackState = 'LOCKED' | 'ACTIVE' | 'PASSED' | 'REMEDIATION';
export type TeacherPracticeEvidence = 'VERIFIED' | 'MODEL_ASSESSED' | 'SELF_REPORTED';
export interface TeacherVerdict {
  passed: boolean;
  score: number;
  criteria: { name: string; met: boolean; comment?: string }[];
  feedback: string;
  inconsistent?: true;
  invalid?: true;
  selfReported?: true;
}
export interface TeacherTracks {
  version: number;
  theory: { state: TeacherTrackState; evaluation: { kind: string }; lastVerdict: TeacherVerdict | null; passedAt: string | null; attempts: number };
  practice: {
    state: TeacherTrackState;
    spec: { kind: string; instructions: string; checklist?: string[]; rubric?: string[]; generated?: boolean };
    evidence: TeacherPracticeEvidence | null; lastVerdict: TeacherVerdict | null; passedAt: string | null; attempts: number;
  };
}
/** What the server returns for any parcours (V1 rows have schema_version 1, legacy true, no tracks). */
export type DualTrackLearningPath = LearningPath & { schema_version: number; mode: string; profile: unknown; legacy: boolean };
export type DualTrackLearningStep = LearningPathStep & {
  tracks: TeacherTracks | null;
  legacy: boolean;
  track_view: TeacherTracks | { theory: { state: TeacherTrackState; source: string }; practice: { state: 'NOT_APPLICABLE' } } | null;
};
export interface TeacherEvaluationResult {
  evaluated: boolean;
  verdict: TeacherVerdict;
  can_advance: boolean;
  path: DualTrackLearningPath;
  steps: DualTrackLearningStep[];
}
export interface TeacherTrackAttempt {
  id: string; path_id: string; step_id: string; track: TeacherTrackName;
  payload: Record<string, unknown>; verdict: TeacherVerdict; passed: boolean; evidence: TeacherPracticeEvidence | null; created_at: string;
}
// ── [/Professeur V2 — PROF-2] ─────────────────────────────────────────────────────────────────────────────────────

// ── [Professeur V2 — PROF-3] UI théorie / pratique — additive types ────────────────────────────────────────────────
export type TeacherPracticeMode = 'self_report' | 'deliverable';
export interface TeacherPracticeSpecResult {
  generated: boolean;
  cached?: boolean;
  reason?: string;
  path: DualTrackLearningPath;
  steps: DualTrackLearningStep[];
}
export interface TeacherDualTrackAdvanceResult { path: DualTrackLearningPath; steps: DualTrackLearningStep[]; finished: boolean }
// ── [/Professeur V2 — PROF-3] ─────────────────────────────────────────────────────────────────────────────────────

// ── [Professeur V2 — PROF-4] remédiation ciblée + historique — additive types ──────────────────────────────────────
export interface TeacherRemediation { focus: string; why: string; retry: string; source: 'model' | 'criteria' | 'checklist' }
// Declaration merging: a failing verdict may carry a targeted remediation (advisory, never changes `passed`).
export interface TeacherVerdict { remediation?: TeacherRemediation }
/** Learner-facing view of one stored attempt (GET …/attempts). `verdict` is null and `corrupted` true for an unreadable row. */
export interface TeacherAttemptView {
  id: string | null;
  track: TeacherTrackName | null;
  index: number;
  created_at: string | null;
  passed: boolean;
  evidence: TeacherPracticeEvidence | null;
  payload: { answer?: string; mode?: 'self_report' | 'deliverable'; submission?: string; confirmations?: boolean[]; note?: string; checkin?: SportCheckin };
  verdict: TeacherVerdict | null;
  corrupted?: true;
}
// ── [/Professeur V2 — PROF-4] ─────────────────────────────────────────────────────────────────────────────────────

// ── [Professeur V2 — PROF-5] Sport Coach — additive types ─────────────────────────────────────────────────────────
export interface SportProfileInput {
  goal: string; goal_custom?: string; level: string; sport_history?: string;
  locations: string[]; equipment: string[]; custom_equipment?: string[];
  sessions_per_week: number; session_minutes: number; weeks?: number; days: string[];
  preferences?: string; liked?: string[]; disliked?: string[];
  limitations?: { declared?: string; areas?: string[] };
  pain?: { present: boolean; areas?: string[]; intensity?: number; worsening?: boolean };
  age?: number | null; progression?: string;
}
export interface SportOptions {
  goals: string[]; levels: string[]; locations: string[]; equipment: string[]; areas: string[]; days: string[]; progression: string[];
  labels: Record<'goals' | 'levels' | 'locations' | 'equipment' | 'areas' | 'progression', Record<string, string>>;
  limits: { sessionsPerWeek: [number, number]; sessionMinutes: [number, number]; weeks: [number, number]; maxSessions: number; age: [number, number]; painStop: number };
}
export interface SportExercise {
  id: string | null; name: string; pattern: string; type: 'reps' | 'duration'; equipment: string[]; areas: string[];
  sets: number; reps: number | null; duration_sec: number | null; rest_sec: number; tempo: string | null; rpe: number;
  cues: string[]; mistakes: string[]; easier: string | null; harder: string | null;
  substitution: { name: string; equipment: string[] } | null; note?: string;
}
export interface SportSession {
  index: number; week: number; day: string; template: string; title: string; summary: string;
  warmup: { name: string; duration_sec: number }[]; exercises: SportExercise[]; cooldown: { name: string; duration_sec: number }[];
  estimated_minutes: number;
}
export interface SportProgram {
  source: 'model' | 'catalog'; fallback_reason: string | null; youth: boolean; excluded_areas: string[]; notice: string | null;
  sessions?: SportSession[]; session_count?: number;
}
export interface SportPathProfile { version: number; athlete: SportProfileInput; program: SportProgram }
export interface SportCreateError extends Error { code?: string; errors?: { field: string; code: string }[] }
// ── [/Professeur V2 — PROF-5] ─────────────────────────────────────────────────────────────────────────────────────

// ── [Professeur V2 — PROF-6] Sport Coach adaptation — additive types ──────────────────────────────────────────────
export interface SportCheckin {
  completed: boolean; rpe: number | null; unusual_pain: boolean; pain_areas: string[]; pain_worsening: boolean;
  technique_confidence: number; energy: number; unavailable_equipment: string[]; comment: string;
}
export interface SportAdaptation {
  id: string; at: string; kind: 'adjust' | 'observe' | 'pause'; rule: string; reason: string; after_session_index: number;
  changes: { session_index: number; exercise: string; field: string; from: unknown; to: unknown }[]; summary?: string[]; rejected?: number;
}
export interface SportPause { reason: string; at: string; after_session_index: number }
export interface SportProgramState { adaptations?: SportAdaptation[]; pause?: SportPause | null; excluded_areas?: string[]; unavailable_equipment?: string[] }
export type SportProgramWithState = SportProgram & SportProgramState;
export interface SportLoopResult { decision: { kind: 'adjust' | 'observe' | 'pause' | 'none'; rule: string; reason: string }; adaptation: SportAdaptation | null; pause: SportPause | null }
// ── [/Professeur V2 — PROF-6] ─────────────────────────────────────────────────────────────────────────────────────

export type RassilonWorkerState = 'DISABLED' | 'IDLE' | 'WORKING' | 'PAUSED' | 'AUTO_PAUSED' | 'ERROR';

export interface RassilonSettings {
  enabled: boolean;
  maxCpuPercent: number;
  maxRamMb: number;
  maxConcurrentJobs: number;
  maxJobDurationSec: number;
  maxScratchMb: number;
  pauseOnBattery: boolean;
  minimumBatteryPercent: number;
  pauseWhenUserActive: boolean;
  acceptedJobTypes: Array<'SAFE_CPU_TASK' | 'EMBEDDING_BATCH'>;
  approvalMode: 'ASK_EACH_JOB' | 'AUTO_ACCEPT_ALLOWED_TYPES';
  updatedAt: string | null;
}

export interface RassilonStatus {
  ok: boolean;
  state: RassilonWorkerState;
  enabled: boolean;
  queueDepth: number;
  activeJob: { jobId: string; jobType: string | null; startedAt: string } | null;
  remoteController: { deviceId: string; displayName: string; fingerprint: string } | null;
  settings: RassilonSettings;
  error: { code: string; message: string; timestamp: string } | null;
}

export interface RassilonLanStatus {
  state: 'DISABLED' | 'STARTING' | 'LISTENING' | 'ERROR';
  error: string | null;
  bindAddress: string | null;
  port: number | null;
  certificateFingerprint: string | null;
}

export interface RassilonDevice {
  deviceId: string;
  displayName: string;
  fingerprint: string;
  role: 'CONTROLLER' | 'WORKER' | 'BOTH';
  permissions: string[];
  status: string;
  presence: 'ONLINE' | 'STALE' | 'OFFLINE' | 'REVOKED';
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  session: {
    direction: 'INBOUND' | 'OUTBOUND';
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string | null;
    active: boolean;
    revokedAt: string | null;
  } | null;
}

export interface RassilonPairingOffer {
  pairingId: string;
  code: string;
  expiresAt: string;
  workerNonce: string;
  worker: { deviceId: string; displayName: string; fingerprint: string };
}

export interface RassilonPairingView {
  pairingId: string;
  state: string;
  controllerDeviceId: string | null;
  controllerDisplayName: string | null;
  controllerFingerprint: string | null;
  requestedPermissions: string[];
  approvedPermissions: string[];
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  usedAt: string | null;
  cancelledAt: string | null;
}

export interface RassilonAuditEvent {
  id: number;
  eventType: string;
  deviceId: string | null;
  jobId: string | null;
  jobType: string | null;
  timestamp: string;
  status: 'OK' | 'INFO' | 'ERROR';
}

// ── Device Fabric (Phase 2: inventory + explicit linking, no routing) ───────

export type FabricAgentType = 'OMEGA' | 'RASSILON';
export type FabricTri = 'YES' | 'NO' | 'UNKNOWN';
export type FabricTrust = 'TRUSTED' | 'REVOKED' | 'UNKNOWN';
export type FabricAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN' | 'ERROR';
export type FabricDeviceState = 'ONLINE' | 'PARTIAL' | 'OFFLINE' | 'UNKNOWN' | 'ERROR';
export type FabricDirection = 'REMOTE_ACTS_ON_THIS_PC' | 'THIS_PC_SENDS_COMPUTE' | 'DEVICE_SENDS_COMPUTE' | 'LOCAL_WORKER';
export type FabricLinkState = 'OK' | 'MISSING' | 'FINGERPRINT_MISMATCH' | 'CROSS_AGENT_KEY_REUSE' | 'AGENT_ERROR';

// RASSILON presence as last verified by an authenticated exchange, and the
// outbound session state (no identifier, only state + expiry).
export interface FabricPresence {
  state: 'VERIFIED' | 'STALE' | 'NOT_VERIFIED' | 'REVOKED';
  lastVerifiedAt: string | null;
  ageMs: number | null;
  freshnessWindowMs: number;
}

export interface FabricSession {
  state: 'VALID' | 'EXPIRING' | 'EXPIRED' | 'REVOKED' | 'NONE' | 'UNKNOWN';
  expiresAt: string | null;
  expiresInMs: number | null;
}

export interface FabricCapability {
  name: string;
  supported: FabricTri;
  authorized: FabricTri;
  available: FabricTri;
  routable: boolean;
}

export interface FabricAgentIdentity {
  agentType: FabricAgentType;
  agentDeviceId: string;
  displayName: string;
  fingerprint: string | null;
  role: string;
  trust: FabricTrust;
  revokedAt: string | null;
  lastSessionAt?: string | null;
  lastSeenAt?: string | null;
  permissionLevel?: number | null;
  linkedFabricDeviceId?: string | null;
}

export interface FabricAgentLink {
  agentType: FabricAgentType;
  agentDeviceId: string;
  linkedFingerprint: string;
  linkedAt: string;
  linkState: FabricLinkState;
  trust: FabricTrust;
  availability: FabricAvailability;
  routable: boolean;
  routingStatus: 'READY' | 'NOT_AVAILABLE' | 'NOT_ROUTABLE';
  routingReason: string | null;
  identity: FabricAgentIdentity | null;
  directions: Array<{ direction: FabricDirection; availability?: FabricAvailability; capabilities: FabricCapability[]; presence?: FabricPresence; session?: FabricSession }>;
}

export interface FabricDevice {
  fabricDeviceId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  state: FabricDeviceState;
  agents: { OMEGA: FabricAgentLink | null; RASSILON: FabricAgentLink | null };
}

export interface FabricAuditEvent {
  id: number;
  createdAt: string;
  eventType: string;
  fabricDeviceId: string | null;
  agentType: FabricAgentType | null;
  agentDeviceId: string | null;
  reason: string | null;
  operationId?: string | null;
  correlationId?: string | null;
}

export type FabricActionType = 'RASSILON_SAFE_CPU' | 'RASSILON_EMBEDDING';
export type FabricOperationStatus = 'PENDING' | 'ROUTING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'NOT_AVAILABLE';

export interface FabricOperation {
  operationId: string;
  correlationId: string;
  fabricDeviceId: string;
  agentType: 'RASSILON';
  agentDeviceId: string;
  actionType: FabricActionType;
  jobType: 'SAFE_CPU_TASK' | 'EMBEDDING_BATCH';
  agentOperationId: string | null;
  status: FabricOperationStatus;
  inputSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown> | null;
  safeError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface FabricRouteRequest {
  fabricDeviceId: string;
  actionType: FabricActionType;
  semanticPayload: Record<string, unknown>;
}

// ── Device Fabric V2 (Phase 2: OMEGA V2 outbound link + exact resolution +
// read-only status, no VIEW/INTERACTIVE/ADMIN/STOP routing) ─────────────────
// A separate, distinct link kind from FabricAgentType's 'OMEGA' (OMEGA V1
// inbound — a remote device paired TO this PC). OMEGA_V2_OUTBOUND names a
// host THIS PC is allowed to control OUTBOUND, in a disjoint identity space
// (omegaV2HostId is 'ov2h-<uuid>', never an omega_devices.id).
export type OmegaV2LinkState = 'OK' | 'MISSING' | 'FINGERPRINT_MISMATCH' | 'REVOKED';
export type OmegaV2Availability = 'AVAILABLE' | 'UNKNOWN' | 'UNAVAILABLE';
export type OmegaV2Permission = 'VIEW' | 'INTERACTIVE' | 'ADMIN';

export interface OmegaV2Trust {
  omegaV2HostId: string;
  host: string;
  port: number;
  identityFingerprint: string;
  certificateFingerprint: string;
  maxPermission: OmegaV2Permission;
  createdAt: string;
  revokedAt: string | null;
}

export interface OmegaV2HostListing extends OmegaV2Trust {
  linkedFabricDeviceId: string | null;
}

export interface OmegaV2Capability {
  name: OmegaV2Permission;
  supported: FabricTri;
  authorized: FabricTri;
  available: FabricTri;
}

export interface OmegaV2Link {
  linkId: string;
  omegaV2HostId: string;
  linkedFingerprint: string;
  linkVersion: number;
  linkedAt: string;
  linkState: OmegaV2LinkState;
  trust: OmegaV2Trust | null;
  availability: OmegaV2Availability;
  capabilities: OmegaV2Capability[];
  session?: { permission: OmegaV2Permission; expiresAt: string } | null;
}

export interface FabricOmegaV2ViewState {
  fabricDeviceId: string;
  omegaV2HostId: string | null;
  linkId: string | null;
  linkVersion: number | null;
  sessionId: string | null;
  sessionStatus: string;
  sessionReason: string | null;
  viewStatus: string;
  streamId: string | null;
  screenIndex: number | null;
  interactiveStatus: string;
  linkChanged: boolean;
  linkReason?: string | null;
}

// Phase 5: closed 9-action ADMIN allowlist result shapes. `result` is only
// ever OMEGA V2's own already-safe-bounded projection (system/processes/
// services/interfaces/disks) — Fabric neither widens nor stores it.
export type FabricOmegaV2AdminReadResult = {
  fabricDeviceId: string;
  omegaV2HostId: string;
  sessionId: string;
  status: string;
  actionType: string;
  error?: string | null;
  result?: Record<string, unknown>;
};
export type FabricOmegaV2AdminOperation = {
  fabricDeviceId: string;
  omegaV2HostId: string;
  sessionId: string;
  operationId: string;
  actionType: string;
  status: string;
  error?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  result?: Record<string, unknown>;
};
export interface FabricOmegaV2AdminState {
  fabricDeviceId: string;
  omegaV2HostId: string | null;
  sessionId: string | null;
  sessionStatus: string;
  linkChanged: boolean;
}
export interface FabricOmegaV2StopResult {
  fabricDeviceId: string;
  sessionId: string | null;
  stopped: boolean;
}

async function deviceFabricJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/device-fabric${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }, 15_000);
  const data = await res.json().catch(() => ({ error: `HTTP_${res.status}` })) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `DEVICE_FABRIC HTTP ${res.status}`);
  return data;
}

// Routing and probe must never be sent twice: a single attempt, no network
// retry (apiFetch retries on network errors, which could duplicate a job).
async function deviceFabricPostOnce<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchTimeout(`${BASE}/api/device-fabric${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 30_000);
  const data = await res.json().catch(() => ({ error: `HTTP_${res.status}` })) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `DEVICE_FABRIC HTTP ${res.status}`);
  return data;
}

async function rassilonJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/rassilon${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }, 15_000);
  const data = await res.json().catch(() => ({ error: `HTTP_${res.status}` })) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `RASSILON HTTP ${res.status}`);
  return data;
}

// ── Singleton client ───────────────────────────────────────────────────────

// ── [Agency V1] types ─────────────────────────────────────────────────────────────────────────────────────────────
export type AgencyRunStatus = 'PLANNING' | 'QUEUED' | 'RUNNING' | 'WAITING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REVOKED';
export type AgencyTaskStatus = 'QUEUED' | 'RUNNING' | 'WAITING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REVOKED' | 'BLOCKED' | 'UNKNOWN';
export interface AgencyRun {
  id: string; objective: string; status: AgencyRunStatus; strictLocal: boolean; maxConcurrency: number; saveResult: boolean;
  plan: { source?: 'model' | 'fallback'; warnings?: string[]; model?: string | null; autoStart?: boolean; taskCount?: number };
  synthesis: string | null; error: string | null; stopReason: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
}
export interface AgencyTask {
  id: string; runId: string; key: string; ord: number; title: string; instructions: string; agent: string; tools: string[];
  dependsOn: string[]; status: AgencyTaskStatus; attempt: number; maxAttempts: number; result: string | null; error: string | null;
  startedAt: string | null; finishedAt: string | null;
}
export interface AgencyArtifact { id: string; runId: string; taskId: string | null; kind: 'task_result' | 'synthesis' | 'saved_output'; title: string; content: string; sha256: string; outputId: string | null; createdAt: string }
export interface AgencyApproval {
  id: string; runId: string; taskId: string; action: string; digest: string; summary: { title?: string; chars?: number; excerpt?: string };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED'; createdAt: string; expiresAt: string; decidedAt: string | null; consumedAt: string | null;
}
export interface AgencyEvent { id: number; taskId: string | null; type: string; detail: Record<string, unknown>; at: string }
export interface AgencyAgent { label: string; description: string; tools: string[]; systemOnly?: boolean }
export interface AgencyTool { impact: 'low' | 'high'; label: string; readOnly?: boolean; requiresApproval?: boolean }
export interface AgencySnapshot {
  run: AgencyRun; tasks: AgencyTask[]; artifacts: AgencyArtifact[]; approvals: AgencyApproval[]; events: AgencyEvent[];
  agents: Record<string, AgencyAgent>; tools: Record<string, AgencyTool>;
}
export type AgencyError = Error & { code?: string; status?: number };

/** Mutating Agency calls are never retried automatically (a retry could create a second run). */
async function agencyCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchTimeout(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } }, 30_000);
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.error, status: res.status }) as AgencyError;
  return data as T;
}
// ── [/Agency V1] types ────────────────────────────────────────────────────────────────────────────────────────────

// ── [Model Router V1] types ───────────────────────────────────────────────────────────────────────────────────────
export type ModelCapability = 'TEXT' | 'VISION' | 'AUDIO' | 'EMBEDDING' | 'TOOL_USE' | 'STRUCTURED_OUTPUT' | 'IMAGE_GENERATION' | 'LONG_CONTEXT';
export interface ModelFact<T> { value: T | null; source: 'runtime' | 'catalog' | 'unknown' | string }
export interface ModelRouterProvider {
  id: string; label: string; location: 'LOCAL' | 'LAN' | 'CLOUD'; runtime: string; kind: 'llm' | 'image'; paid: boolean;
  configured: boolean | null; available: boolean | null; status: string; reason: string | null;
}
export interface ModelRouterModel {
  id: string; provider: string; name: string; location: 'LOCAL' | 'CLOUD'; runtime: string; installed: boolean | null; available: boolean;
  capabilities: ModelCapability[]; capabilitiesKnown: boolean; capabilitiesSource: string;
  contextLength: ModelFact<number>; family: ModelFact<string>; parameterSize: ModelFact<string>;
  lowVram: null | {
    quantization: ModelFact<string>; sizeBytes: ModelFact<number>; gpuLayers: ModelFact<number>;
    loaded: null | { sizeBytes: number | null; vramBytes: number | null; ramOffloadBytes: number | null };
    fit: null | { rating: string; estimates: { ramBytes: number | null; vramBytes: number | null; diskBytes: number | null }; confidence: string; source: string };
  };
  catalog: null | { canonicalId: string; license: string | null; trustLevel: string };
}
export interface ModelRouterRegistry {
  ok: boolean; strictLocal: boolean; cloudEnabled: boolean; cloudAllowed: boolean;
  hardware: null | { gpus: Array<{ name: string | null; vramBytes: number | null }>; totalVramBytes: number | null; ramBytes: number | null };
  providers: ModelRouterProvider[]; models: ModelRouterModel[]; pendingIdentity: Array<{ target: string; status: string }>;
}
export interface ModelRouterError { code: string; message: string; hint: string | null }
export interface ModelRouteDecision {
  ok: boolean; mode: 'auto' | 'manual'; required?: ModelCapability[];
  decision?: { provider: string; model: string; modelId: string; location: string; reason: string };
  rejected: Array<{ id: string; reason: string }>; warnings?: string[]; error?: ModelRouterError;
}
export interface ModelRouteRequest {
  capabilities: ModelCapability[]; mode: 'auto' | 'manual'; provider?: string | null; model?: string | null;
  prompt?: string; responseFormat?: 'text' | 'json'; runtimeOptions?: { num_ctx?: number; num_gpu?: number }; timeoutMs?: number;
}
export interface ModelRunResult {
  ok: boolean; decision?: ModelRouteDecision['decision']; warnings?: string[]; error?: ModelRouterError;
  rejected?: ModelRouteDecision['rejected'];
  result?: { text: string; json: unknown; provider: string; model: string; location: string; durationMs: number };
}

async function modelRouterCall<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  // Never retried automatically: a run is a real model call.
  const res = await fetchTimeout(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } }, timeoutMs);
  const data = await res.json().catch(() => ({ ok: false, error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}`, hint: null } }));
  return data as T; // 4xx/5xx carry a structured { ok:false, error } body shown as is
}
// ── [/Model Router V1] types ──────────────────────────────────────────────────────────────────────────────────────

// ── [Document Toolbox PDF V1] types ───────────────────────────────────────────────────────────────────────────────
export interface ToolboxDoc {
  id: string; name: string; kind: 'pdf' | 'png' | 'jpeg' | 'webp' | 'gif'; size: number; pageCount: number | null; createdAt: string;
  origin: null | { op: string; sources?: string[]; pages?: number[]; before?: number; after?: number; status?: string };
  info?: ToolboxPdfInfo;
}
export interface ToolboxPdfInfo {
  pageCount: number;
  pages: Array<{ page: number; width: number; height: number; rotation: number }>;
  metadata: { title: string | null; author: string | null; subject: string | null; keywords: string | null; creator: string | null; producer: string | null; creationDate: string | null; modificationDate: string | null };
}
export interface ToolboxError { code: string; message: string }
export type ToolboxOperation =
  | { op: 'merge'; docIds: string[] }
  | { op: 'split'; docId: string; ranges?: string; every?: number }
  | { op: 'extract' | 'delete' | 'duplicate'; docId: string; pages: number[] }
  | { op: 'reorder'; docId: string; order: number[] }
  | { op: 'rotate'; docId: string; pages: number[]; angle: 90 | 180 | 270 }
  | { op: 'metadata'; docId: string; metadata: { title?: string; author?: string; subject?: string; keywords?: string } }
  | { op: 'watermark'; docId: string; watermark: { text: string; opacity?: number; size?: number; angle?: number; pages?: number[] } }
  | { op: 'images_to_pdf'; docIds: string[]; fit?: 'image' | 'a4' }
  | { op: 'pdf_to_images'; docId: string; pages?: number[]; scale?: number }
  | { op: 'compress'; docId: string };
export interface ToolboxOperationResult {
  ok: boolean; outputs?: ToolboxDoc[]; error?: ToolboxError;
  compression?: { status: 'COMPRESSION_LIMITED'; before: number; after: number; smaller: boolean };
}

/** Local PDF workshop calls: no automatic retry (each operation creates documents). */
async function toolboxCall<T>(path: string, init: RequestInit = {}, timeoutMs = 180_000): Promise<T> {
  const res = await fetchTimeout(`${BASE}${path}`, init, timeoutMs);
  const data = await res.json().catch(() => ({ ok: false, error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` } })) as { ok?: boolean; error?: ToolboxError };
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error?.message ?? `HTTP ${res.status}`), { code: data.error?.code ?? `HTTP_${res.status}` });
  return data as T;
}
// ── [/Document Toolbox PDF V1] types ──────────────────────────────────────────────────────────────────────────────

// ── [Media Studio V1] types ───────────────────────────────────────────────────────────────────────────────────────
export type MediaAssetKind = 'video' | 'audio' | 'image';
export interface MediaAsset {
  id: string; name: string; file: string; kind: MediaAssetKind; size: number; durationMs: number | null;
  hasVideo: boolean; hasAudio: boolean; width: number | null; height: number | null; sha256: string;
  source: { type: 'upload' | 'media-reader' | 'docteur-image'; url?: string; imageId?: string }; addedAt: string;
}
export interface MediaClip {
  id: string; trackId: 'V1' | 'A1'; assetId: string; inMs: number; outMs: number;
  volume: number; muted: boolean; fadeInMs: number; fadeOutMs: number; startMs?: number;
}
export interface MediaTrack { id: 'V1' | 'A1'; kind: 'video' | 'audio'; name: string; muted: boolean; volume: number }
export type MediaResolution = '640x360' | '1280x720' | '1920x1080' | '1080x1920';
export interface MediaProject {
  id: string; name: string; version: number;
  settings: { resolution: MediaResolution; fps: 24 | 25 | 30 };
  assets: MediaAsset[]; tracks: MediaTrack[]; clips: MediaClip[];
  exportConfig: { format: 'mp4'; crf: number; preset: string }; createdAt: string; updatedAt: string;
}
export type MediaExportStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface MediaExportJob {
  id: string; projectId: string; status: MediaExportStatus; progress: number; durationMs: number | null;
  outputFile: string | null; outputSize: number | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface MediaProjectView {
  project: MediaProject;
  timeline: { video: Array<MediaClip & { startMs: number }>; audio: MediaClip[]; durationMs: number };
  jobs: MediaExportJob[];
}
export interface MediaProjectSummary { id: string; name: string; assetCount: number; clipCount: number; createdAt: string; updatedAt: string }
export type MediaEdit =
  | { op: 'add'; assetId: string; trackId?: 'V1' | 'A1'; startMs?: number }
  | { op: 'trim'; clipId: string; inMs: number; outMs: number }
  | { op: 'split'; clipId: string; atMs: number }
  | { op: 'reorder'; clipId: string; toIndex: number }
  | { op: 'move'; clipId: string; startMs: number }
  | { op: 'update'; clipId: string; volume?: number; muted?: boolean; fadeInMs?: number; fadeOutMs?: number; durationMs?: number }
  | { op: 'delete'; clipId: string }
  | { op: 'track'; trackId: 'V1' | 'A1'; muted?: boolean; volume?: number }
  | { op: 'settings'; resolution?: MediaResolution; fps?: 24 | 25 | 30; name?: string };
export interface MediaUploadProgress { sent: number; total: number }
export const MEDIA_STUDIO_MAX_BYTES = 1024 * 1024 * 1024;
const MEDIA_CHECKSUM_MAX_BYTES = 256 * 1024 * 1024; // above, the browser would hold the whole file in memory to hash it

/** Local media studio calls: no automatic retry (edits / uploads / exports are not idempotent). */
async function mediaStudioCall<T>(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<T> {
  const headers = init.body instanceof Blob ? init.headers : { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const res = await fetchTimeout(`${BASE}${path}`, { ...init, headers }, timeoutMs);
  const data = await res.json().catch(() => ({ ok: false, error: { code: `HTTP_${res.status}`, message: `HTTP ${res.status}` } })) as { ok?: boolean; error?: { code: string; message: string } };
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error?.message ?? `HTTP ${res.status}`), { code: data.error?.code ?? `HTTP_${res.status}` });
  return data as T;
}
async function sha256Hex(blob: Blob): Promise<string | null> {
  if (blob.size > MEDIA_CHECKSUM_MAX_BYTES || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
/** Docteur image route (/api/image/<id>) → its id: imported server-side, the bytes never transit through the browser. */
export function docteurImageIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(BASE).origin) return null;
    const m = /^\/api\/image\/([^/]+)$/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
// ── [/Media Studio V1] types ──────────────────────────────────────────────────────────────────────────────────────

export const cortexClient = {
  get isAvailable(): boolean { return _available; },
  get lastCheck(): Date | null { return _lastCheck; },

  rassilonStatus(): Promise<RassilonStatus> {
    return rassilonJson<RassilonStatus>('/status');
  },

  rassilonLanStatus(): Promise<{ ok: boolean; lan: RassilonLanStatus }> {
    return rassilonJson('/lan/status');
  },

  rassilonDevices(): Promise<{ ok: boolean; devices: RassilonDevice[] }> {
    return rassilonJson('/devices');
  },

  rassilonAudit(limit = 50): Promise<{ ok: boolean; events: RassilonAuditEvent[] }> {
    return rassilonJson(`/audit?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`);
  },

  rassilonEnable(settings: Omit<RassilonSettings, 'enabled' | 'updatedAt'>): Promise<RassilonStatus> {
    return rassilonJson('/enable', 'POST', settings);
  },

  rassilonDisable(): Promise<RassilonStatus> {
    return rassilonJson('/disable', 'POST', {});
  },

  rassilonPause(): Promise<RassilonStatus> {
    return rassilonJson('/pause', 'POST', {});
  },

  rassilonResume(): Promise<RassilonStatus> {
    return rassilonJson('/resume', 'POST', {});
  },

  rassilonStop(): Promise<RassilonStatus> {
    return rassilonJson('/stop', 'POST', {});
  },

  rassilonUpdateSettings(settings: Partial<Omit<RassilonSettings, 'enabled' | 'updatedAt'>>): Promise<{ ok: boolean; settings: RassilonSettings }> {
    return rassilonJson('/settings', 'PUT', settings);
  },

  rassilonLanEnable(input: { bindAddress: string; port: number; networkProfile: 'Private' | 'Unknown'; allowUnknownNetworkProfile: boolean }): Promise<{ ok: boolean; lan: RassilonLanStatus }> {
    return rassilonJson('/lan/enable', 'POST', input);
  },

  rassilonLanDisable(): Promise<{ ok: boolean; lan: RassilonLanStatus }> {
    return rassilonJson('/lan/disable', 'POST', {});
  },

  rassilonStartPairing(): Promise<{ ok: boolean; pairing: RassilonPairingOffer }> {
    return rassilonJson('/pairing/start', 'POST', {});
  },

  rassilonPairing(pairingId: string): Promise<{ ok: boolean; pairing: RassilonPairingView }> {
    return rassilonJson(`/pairing/${encodeURIComponent(pairingId)}`);
  },

  rassilonConfirmPairing(pairingId: string, approvedPermissions: string[]): Promise<{ ok: boolean; pairing: RassilonPairingView }> {
    return rassilonJson(`/pairing/${encodeURIComponent(pairingId)}/confirm`, 'POST', { approvedPermissions });
  },

  rassilonRejectPairing(pairingId: string): Promise<{ ok: boolean; pairing: RassilonPairingView }> {
    return rassilonJson(`/pairing/${encodeURIComponent(pairingId)}/reject`, 'POST', {});
  },

  rassilonRevokeDevice(deviceId: string): Promise<{ ok: boolean; revoked: boolean; cancelledJobs: number }> {
    return rassilonJson(`/devices/${encodeURIComponent(deviceId)}/revoke`, 'POST', {});
  },

  deviceFabricDevices(): Promise<{ ok: boolean; devices: FabricDevice[] }> {
    return deviceFabricJson('/devices');
  },

  deviceFabricAgents(): Promise<{ ok: boolean; agents: Record<FabricAgentType, FabricAgentIdentity[]>; agentErrors?: Partial<Record<FabricAgentType, string>> }> {
    return deviceFabricJson('/agents');
  },

  deviceFabricAudit(limit = 30): Promise<{ ok: boolean; events: FabricAuditEvent[] }> {
    return deviceFabricJson(`/audit?limit=${Math.max(1, Math.min(500, Math.trunc(limit)))}`);
  },

  deviceFabricCreate(displayName: string): Promise<{ ok: boolean; device: FabricDevice }> {
    return deviceFabricJson('/devices', 'POST', { displayName });
  },

  deviceFabricRename(fabricDeviceId: string, displayName: string): Promise<{ ok: boolean; device: FabricDevice }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}`, 'PATCH', { displayName });
  },

  deviceFabricRemove(fabricDeviceId: string, confirmLinks: boolean): Promise<{ ok: boolean; removed: boolean }> {
    const query = confirmLinks ? '?confirm=REMOVE_LINKS' : '';
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}${query}`, 'DELETE');
  },

  deviceFabricLink(fabricDeviceId: string, agentType: FabricAgentType, agentDeviceId: string, confirmFingerprint: string): Promise<{ ok: boolean; device: FabricDevice }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/link`, 'POST', { agentType, agentDeviceId, confirmFingerprint });
  },

  deviceFabricUnlink(fabricDeviceId: string, agentType: FabricAgentType): Promise<{ ok: boolean; device: FabricDevice }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/link/${agentType}`, 'DELETE');
  },

  // Explicit, user-triggered routing to the exact RASSILON worker of a device.
  deviceFabricRoute(request: FabricRouteRequest): Promise<{ ok: boolean; operation: FabricOperation }> {
    return deviceFabricPostOnce('/route', request);
  },

  deviceFabricOperations(limit = 20): Promise<{ ok: boolean; operations: FabricOperation[] }> {
    return deviceFabricJson(`/operations?limit=${Math.max(1, Math.min(100, Math.trunc(limit)))}`);
  },

  deviceFabricProbe(fabricDeviceId: string): Promise<{ ok: boolean; device: FabricDevice }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/rassilon/probe`, {});
  },

  // ── OMEGA V2 outbound: link/status (Phase 2), closed VIEW (Phase 3) and
  // closed INTERACTIVE (Phase 4) orchestration only. No ADMIN, generic
  // route, or raw input call exists here.
  deviceFabricOmegaV2Hosts(): Promise<{ ok: boolean; hosts: OmegaV2HostListing[] }> {
    return deviceFabricJson('/omega-v2/hosts');
  },

  deviceFabricOmegaV2Status(fabricDeviceId: string): Promise<{ ok: boolean; link: OmegaV2Link | null }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/status`);
  },

  deviceFabricOmegaV2Link(fabricDeviceId: string, omegaV2HostId: string, confirmFingerprint: string): Promise<{ ok: boolean; link: OmegaV2Link }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/link`, 'POST', { omegaV2HostId, confirmFingerprint });
  },

  deviceFabricOmegaV2Unlink(fabricDeviceId: string): Promise<{ ok: boolean; unlinked: boolean }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/link`, 'DELETE');
  },

  deviceFabricOmegaV2ViewStart(fabricDeviceId: string, link: OmegaV2Link, screenIndex = 0): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/view/start`, {
      screenIndex, linkId: link.linkId, linkVersion: link.linkVersion,
      omegaV2HostId: link.omegaV2HostId, fingerprint: link.linkedFingerprint,
    });
  },

  deviceFabricOmegaV2ViewStatus(fabricDeviceId: string): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/view/status`);
  },

  deviceFabricOmegaV2ViewStop(fabricDeviceId: string): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/view/stop`, {});
  },

  deviceFabricOmegaV2SessionStop(fabricDeviceId: string): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/session/stop`, {});
  },

  // Phase 4: explicit INTERACTIVE elevation of an already-active VIEW.
  // Pointer/keyboard/wheel events never go through Fabric — the browser
  // calls OMEGA V2's own certified input routes directly with the
  // sessionId this state exposes (mirrors omegaOutboundViewFrame's pattern).
  deviceFabricOmegaV2InteractiveStart(fabricDeviceId: string): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/interactive/start`, {});
  },

  deviceFabricOmegaV2InteractiveStatus(fabricDeviceId: string): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/interactive/status`);
  },

  deviceFabricOmegaV2InteractiveStop(fabricDeviceId: string): Promise<{ ok: boolean; view: FabricOmegaV2ViewState }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/interactive/stop`, {});
  },

  // Phase 5: closed 9-action ADMIN allowlist + Fabric controller STOP. Every
  // call is a typed wrapper; there is no generic action string anywhere.
  deviceFabricOmegaV2AdminSystemInfo(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminReadResult }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/system-info`, {});
  },
  deviceFabricOmegaV2AdminProcesses(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminReadResult }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/processes`, {});
  },
  deviceFabricOmegaV2AdminServiceStatus(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminReadResult }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/service-status`, {});
  },
  deviceFabricOmegaV2AdminNetworkStatus(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminReadResult }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/network-status`, {});
  },
  deviceFabricOmegaV2AdminDiskStatus(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminReadResult }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/disk-status`, {});
  },
  deviceFabricOmegaV2AdminStatus(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminState }> {
    return deviceFabricJson(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/status`);
  },

  // Each high-impact call requires the exact typed confirmation naming the
  // action; this only gates Fabric's own request, never the remote device's
  // own local approval (mission §9, §19).
  deviceFabricOmegaV2AdminLock(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/lock`, { confirm: 'LOCK' });
  },
  deviceFabricOmegaV2AdminLogoff(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/logoff`, { confirm: 'LOGOFF' });
  },
  deviceFabricOmegaV2AdminRestart(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/restart`, { confirm: 'RESTART' });
  },
  deviceFabricOmegaV2AdminShutdown(fabricDeviceId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/shutdown`, { confirm: 'SHUTDOWN' });
  },

  deviceFabricOmegaV2AdminOperationStatus(fabricDeviceId: string, operationId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/operations/status`, { operationId });
  },
  deviceFabricOmegaV2AdminOperationCancel(fabricDeviceId: string, operationId: string): Promise<{ ok: boolean; admin: FabricOmegaV2AdminOperation }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/admin/operations/cancel`, { operationId });
  },

  // Fabric-scoped STOP: only sessions Fabric itself opened for this device
  // (VIEW/INTERACTIVE has its own separate session/stop above; ADMIN uses
  // its own session and its own stop).
  deviceFabricOmegaV2AdminStopDevice(fabricDeviceId: string): Promise<{ ok: boolean; fabricDeviceId: string; sessionId: string | null; stopped: boolean }> {
    return deviceFabricPostOnce(`/devices/${encodeURIComponent(fabricDeviceId)}/omega-v2/stop`, {});
  },
  deviceFabricOmegaV2AdminStopAll(): Promise<{ ok: boolean; results: FabricOmegaV2StopResult[] }> {
    return deviceFabricPostOnce('/omega-v2/stop-all', {});
  },

  async omegaOutboundViewFrame(sessionId: string): Promise<Blob> {
    const response = await fetchTimeout(`${BASE}/api/omega/outbound/sessions/${encodeURIComponent(sessionId)}/view/frame`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store',
    }, 15_000);
    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: `HTTP_${response.status}` })) as { error?: string };
      throw new Error(data.error ?? `OMEGA_VIEW_FRAME HTTP ${response.status}`);
    }
    return response.blob();
  },

  async health(): Promise<HealthStatus> {
    try {
      const res  = await fetchTimeout(`${BASE}/api/health`, { method: 'GET' });
      const data = (await res.json()) as HealthStatus;
      _available = data.ollama_connected === true;
      _lastCheck = new Date();
      return data;
    } catch (e) {
      _available = false;
      _lastCheck = new Date();
      throw e;
    }
  },

  async indexNeuron(page: Page): Promise<IndexResult> {
    const content = pageToContent(page);
    const res = await apiFetch('/api/index', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        id:       page.id,
        kind:     page.kind,
        title:    page.title || 'Sans titre',
        content,
        metadata: {
          tags: page.tags ?? [],
          updatedAt: page.updatedAt,
          captureId: typeof page.metadata?.captureId === 'string' ? page.metadata.captureId : undefined,
          captureStatus: typeof page.metadata?.captureStatus === 'string' ? page.metadata.captureStatus : undefined,
        },
      }),
    }, 180_000); // cold model swaps can make an otherwise healthy local embedding slow
    if (!res.ok) {
      const error = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(error.error ? `Index HTTP ${res.status}: ${error.error}` : `Index HTTP ${res.status}`);
    }
    return res.json() as Promise<IndexResult>;
  },

  async capture(input: string): Promise<CaptureResult> {
    const res = await apiFetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) throw new Error(`Capture HTTP ${res.status}`);
    return res.json() as Promise<CaptureResult>;
  },

  async captureDeepPaste(
    text: string,
    source: string,
    url?: string,
    signal?: AbortSignal,
    options: CaptureDeepOptions = {},
  ): Promise<CaptureResult & CanonicalArticleDuplicate & { fallback?: boolean; reason?: string; error?: string; model_used?: string }> {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEEP_CAPTURE_TIMEOUT_MS); // même analyse locale que le mode URL
    signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(`${BASE}/api/capture/deep`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, source, ...(url ? { url } : {}), ...(options.checkDuplicate ? { checkDuplicate: true } : {}) }),
        signal:  ctrl.signal,
      });
      if (!res.ok) throw new Error(`Deep capture text HTTP ${res.status}`);
      return res.json() as Promise<CaptureResult & CanonicalArticleDuplicate & { fallback?: boolean; reason?: string; error?: string; model_used?: string }>;
    } catch (e) {
      // Deliberately never auto-retried here — this is a mutating call
      // (creates a neuron) and retrying blind could create a duplicate.
      // A dropped connection mid-request (cortex-server restarting, e.g.
      // from a source edit under nodemon) surfaces as a plain TypeError
      // with no HTTP status to show — give the user a clear, actionable
      // message instead of a raw "Failed to fetch".
      if (isNetworkError(e) && !(e instanceof Error && e.name === 'AbortError')) {
        throw new Error('Cortex Server a redémarré pendant l\'opération. Réessayez.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  async captureDeep(url: string, signal?: AbortSignal, captureImages = false, options: CaptureDeepOptions = {}): Promise<DeepCaptureResult> {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEEP_CAPTURE_TIMEOUT_MS);
    signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(`${BASE}/api/capture/deep`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, captureImages, ...(options.checkDuplicate ? { checkDuplicate: true } : {}) }),
        signal:  ctrl.signal,
      });
      if (!res.ok) throw new Error(`Deep capture HTTP ${res.status}`);
      return res.json() as Promise<DeepCaptureResult>;
    } catch (e) {
      // See captureDeepPaste above — same reasoning: no auto-retry on a
      // mutating call, but a dropped connection gets a clear message
      // instead of a raw network error.
      if (isNetworkError(e) && !(e instanceof Error && e.name === 'AbortError')) {
        throw new Error('Cortex Server a redémarré pendant l\'opération. Réessayez.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  async captureDeepWhisper(
    url: string,
    onProgress: (p: WhisperProgress) => void,
    signal?: AbortSignal,
    provider: 'local' | 'groq' | 'auto' = 'local',
  ): Promise<DeepCaptureResult> {
    const res = await fetch(`${BASE}/api/capture/whisper`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, provider }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Whisper HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Stream terminé sans résultat');
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      const result = parseWhisperSseChunks(parts, onProgress);
      if (result) return result;
    }
  },

  async getWhisperStats(): Promise<WhisperStats> {
    const res = await fetchTimeout(`${BASE}/api/capture/whisper/stats`, { method: 'GET' }, 5_000);
    if (!res.ok) throw new Error(`whisper/stats HTTP ${res.status}`);
    return res.json() as Promise<WhisperStats>;
  },

  async checkYtDlp(): Promise<{ available: boolean; version: string | null }> {
    try {
      const res = await fetchTimeout(`${BASE}/api/download/check`, { method: 'GET' }, 5_000);
      return res.json() as Promise<{ available: boolean; version: string | null }>;
    } catch {
      return { available: false, version: null };
    }
  },

  // Streams SSE events from /api/download. Calls callbacks for each event type.
  downloadVideo(
    url: string,
    mode: 'download' | 'download_analyze',
    folder: string,
    { onProgress, onStatus, signal }: {
      onProgress?: (p: { percent: number; total: string; speed: string; eta: string }) => void;
      onStatus?:   (msg: string) => void;
      signal?:     AbortSignal;
    },
  ): Promise<{ title: string; filePath: string | null; fileSize: number; analysis: string | null }> {
    return new Promise((resolve, reject) => {
      fetch(`${BASE}/api/download`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, mode, folder }),
        signal,
      }).then(async res => {
        if (!res.ok || !res.body) {
          const err = await res.text().catch(() => `HTTP ${res.status}`);
          return reject(new Error(err));
        }
        const reader = res.body.getReader();
        const dec    = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (evt.type === 'progress') onProgress?.(evt as never);
              else if (evt.type === 'status') onStatus?.(evt.message as string);
              else if (evt.type === 'done')  resolve(evt as never);
              else if (evt.type === 'error') reject(new Error(String(evt.message)));
            } catch { /* malformed SSE line */ }
          }
        }
      }).catch(err => {
        if ((err as Error).name === 'AbortError') reject(err);
        else reject(new Error(`Connexion échouée : ${(err as Error).message}`));
      });
    });
  },

  /** YouTube Smart Discovery V2: the URL decides what is discovered (no manual limit). */
  async discoverYouTube(
    input: string,
    options: {
      context?: 'youtube';
      signal?: AbortSignal;
      onEvent?: (event: YouTubeDiscoveryEvent) => void;
    } = {},
  ): Promise<YouTubeDiscoveryResult> {
    const res = await apiFetch('/api/capture/discover', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ input, ...(options.context ? { context: options.context } : {}) }),
      signal:  options.signal,
    }, null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('Réponse de découverte YouTube vide');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const items: PlaylistVideo[] = [];
    let mode: YouTubeDiscoveryMode | null = null;
    let result: YouTubeDiscoveryResult | null = null;
    let buffer = '';
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as YouTubeDiscoveryEvent;
      if (event.type === 'mode') mode = event.mode;
      if (event.type === 'items_batch') for (const item of event.items) items.push(item);
      options.onEvent?.(event);
      if (event.type === 'done') {
        if (event.merged?.length) {
          const byId = new Map(items.map(item => [item.id, item]));
          for (const patch of event.merged) {
            const target = byId.get(patch.id);
            if (target) Object.assign(target, patch);
          }
        }
        result = { mode: event.mode ?? mode as YouTubeDiscoveryMode, channel: event.channel, items, total: event.total, counts: event.counts, duplicates: event.duplicates, durationMs: event.durationMs };
      }
      if (event.type === 'cancelled') {
        const error = new Error('Découverte annulée');
        error.name = 'AbortError';
        throw error;
      }
      if (event.type === 'error') {
        const error = new Error(event.message || 'Échec de la découverte YouTube') as Error & { code?: string };
        error.name = event.name || 'Error';
        error.code = event.code;
        throw error;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    consumeLine(buffer);
    if (!result) throw new Error('Flux de découverte YouTube interrompu avant la fin');
    return result;
  },

  /** Playlist metadata + every video (no manual limit). Thin adapter over discoverYouTube. */
  async getPlaylist(url: string, options: { signal?: AbortSignal; onProgress?: (count: number) => void } = {}): Promise<PlaylistInfo> {
    const found = await cortexClient.discoverYouTube(url, {
      signal: options.signal,
      onEvent: event => { if (event.type === 'progress') options.onProgress?.(event.total); },
    });
    return {
      title:       found.channel.title,
      uploader:    found.channel.uploader,
      playlistId:  found.channel.id,
      video_count: found.total,
      videos:      found.items,
      source_type: found.mode === 'SINGLE_SHORT' ? 'short' : 'videos',
    };
  },

  // ── YouTube Multi-Channel V1: server-side queue (follow it by polling; it keeps running if the view closes) ──
  async startYouTubeChannelBatch(text: string): Promise<YouTubeChannelBatch> {
    return channelQueueCall('/api/capture/discover/channels', { method: 'POST', body: JSON.stringify({ text }) });
  },
  async getYouTubeChannelBatch(batchId: string, signal?: AbortSignal): Promise<YouTubeChannelBatch> {
    return channelQueueCall(`/api/capture/discover/channels/${encodeURIComponent(batchId)}`, { signal });
  },
  async getYouTubeChannelJobItems(batchId: string, jobId: string): Promise<YouTubeChannelJobResult> {
    return channelQueueCall(`/api/capture/discover/channels/${encodeURIComponent(batchId)}/jobs/${encodeURIComponent(jobId)}/items`, {});
  },
  async cancelYouTubeChannelJob(batchId: string, jobId: string): Promise<YouTubeChannelBatch> {
    return channelQueueCall(`/api/capture/discover/channels/${encodeURIComponent(batchId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  },
  async retryYouTubeChannelJob(batchId: string, jobId: string): Promise<YouTubeChannelBatch> {
    return channelQueueCall(`/api/capture/discover/channels/${encodeURIComponent(batchId)}/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
  },
  async cancelYouTubeChannelBatch(batchId: string): Promise<YouTubeChannelBatch> {
    return channelQueueCall(`/api/capture/discover/channels/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' });
  },

  async deleteNeuron(id: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/neuron/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  async optimizeIndex(): Promise<IndexOptimizeResult> {
    const res = await apiFetch('/api/index/optimize', { method: 'POST' }, 15 * 60_000);
    if (!res.ok) throw new Error(`Optimize HTTP ${res.status}`);
    return res.json() as Promise<IndexOptimizeResult>;
  },

  async getIndexStats(): Promise<IndexFragmentStats | null> {
    const res = await apiFetch('/api/index/stats', { method: 'GET' });
    if (!res.ok) return null;
    return res.json() as Promise<IndexFragmentStats>;
  },

  async search(
    query: string,
    opts: { limit?: number; threshold?: number; filter_by_kind?: string[] } = {},
  ): Promise<SearchResult> {
    const res = await apiFetch('/api/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query, ...opts }),
    });
    if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
    return res.json() as Promise<SearchResult>;
  },

  async routerStatus(): Promise<RouterStatus> {
    const res = await apiFetch('/api/router/status', { method: 'GET' });
    if (!res.ok) throw new Error(`Router status HTTP ${res.status}`);
    return res.json() as Promise<RouterStatus>;
  },

  async ollamaModels(): Promise<OllamaModelsResult> {
    const res = await apiFetch('/api/ollama/models', { method: 'GET' });
    if (!res.ok) throw new Error(`Ollama models HTTP ${res.status}`);
    return res.json() as Promise<OllamaModelsResult>;
  },

  async pullOllamaModel(
    model: string,
    onProgress?: (event: OllamaPullProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; model: string }> {
    const res = await fetch(`${BASE}/api/ollama/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal,
    });
    if (!res.ok || !res.body) {
      const message = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(message || `Ollama pull HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: { ok: boolean; model: string } | null = null;

    const flushLines = (lines: string[]): void => {
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let event: OllamaPullProgress;
        try {
          event = JSON.parse(line) as OllamaPullProgress;
        } catch {
          continue;
        }
        onProgress?.(event);
        if (event.error) {
          throw new Error(event.error);
        }
        if (event.done || event.status === 'success') {
          finalResult = { ok: true, model };
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        flushLines(lines);
      }
      if (buffer.trim()) flushLines([buffer]);
      return finalResult ?? { ok: true, model };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw error instanceof Error ? error : new Error('Ollama pull interrompu');
    }
  },

  async deleteOllamaModel(model: string): Promise<{ ok: boolean; model: string }> {
    const res = await apiFetch('/api/ollama/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const message = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(message.error ?? `Ollama delete HTTP ${res.status}`);
    }
    return res.json() as Promise<{ ok: boolean; model: string }>;
  },

  // Local AI catalog (AI-3/AI-4) — all local, no Internet calls. See
  // cortex-server/src/routes/local-ai.js.
  async localAiCatalog(): Promise<LocalAiCatalogResult> {
    const res = await apiFetch('/api/local-ai/catalog', { method: 'GET' });
    if (!res.ok) throw new Error(`Local AI catalog HTTP ${res.status}`);
    return res.json() as Promise<LocalAiCatalogResult>;
  },

  async localAiHardware(forceRefresh = false): Promise<{ profile: LocalHardwareProfile }> {
    const res = await apiFetch(`/api/local-ai/hardware${forceRefresh ? '?refresh=1' : ''}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Local AI hardware HTTP ${res.status}`);
    return res.json() as Promise<{ profile: LocalHardwareProfile }>;
  },

  async localAiRecommendations(options: { capability?: string; localOnly?: boolean } = {}): Promise<LocalAiRecommendationsResult> {
    const params = new URLSearchParams();
    if (options.capability) params.set('capability', options.capability);
    if (options.localOnly === false) params.set('localOnly', '0');
    const qs = params.toString();
    const res = await apiFetch(`/api/local-ai/recommendations${qs ? `?${qs}` : ''}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Local AI recommendations HTTP ${res.status}`);
    return res.json() as Promise<LocalAiRecommendationsResult>;
  },

  async localAiInstalled(): Promise<LocalAiInstalledResult> {
    const res = await apiFetch('/api/local-ai/installed', { method: 'GET' });
    if (!res.ok) throw new Error(`Local AI installed HTTP ${res.status}`);
    return res.json() as Promise<LocalAiInstalledResult>;
  },

  async localAiInstallPreview(distributionId: string): Promise<LocalAiInstallPreviewResult> {
    const res = await apiFetch('/api/local-ai/install-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributionId }),
    });
    const body = await res.json() as LocalAiInstallPreviewResult;
    return body;
  },

  async routerSettings(): Promise<RouterSettings> {
    const res = await apiFetch('/api/router/settings', { method: 'GET' });
    if (!res.ok) throw new Error(`Router settings HTTP ${res.status}`);
    return res.json() as Promise<RouterSettings>;
  },

  async updateRouterSettings(updates: Partial<RouterSettings>): Promise<{ ok: boolean; settings: RouterSettings }> {
    const res = await apiFetch('/api/router/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Update router settings HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; settings: RouterSettings }>;
  },

  async routerStats(): Promise<{ stats: RouterStat[]; cloud_month: CloudMonthStat[] }> {
    const res = await apiFetch('/api/router/stats', { method: 'GET' });
    if (!res.ok) throw new Error(`Router stats HTTP ${res.status}`);
    return res.json() as Promise<{ stats: RouterStat[]; cloud_month: CloudMonthStat[] }>;
  },

  async getCloudKeys(): Promise<CloudKeysMasked> {
    const res = await apiFetch('/api/router/cloud-keys', { method: 'GET' });
    if (!res.ok) throw new Error(`Cloud keys HTTP ${res.status}`);
    return res.json() as Promise<CloudKeysMasked>;
  },

  async setCloudKey(provider: string, key: string): Promise<{ ok: boolean; masked: CloudKeysMasked }> {
    const res = await apiFetch('/api/router/cloud-keys', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ provider, key }),
    });
    if (!res.ok) throw new Error(`Set cloud key HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; masked: CloudKeysMasked }>;
  },

  async testCloudKey(provider: string, key?: string): Promise<{ ok: boolean; model?: string; error?: string; state?: ProviderHealthState; category?: string; authMode?: 'setup_token' | 'cli_session' | 'none' }> {
    const res = await apiFetch(`/api/router/test/${provider}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: key ?? '' }),
    }, 15_000);
    return res.json() as Promise<{ ok: boolean; model?: string; error?: string; state?: ProviderHealthState; category?: string; authMode?: 'setup_token' | 'cli_session' | 'none' }>;
  },

  async testFreeLLMAPI(baseUrl?: string, key?: string): Promise<{ ok: boolean; status: string; configured: boolean; model?: string | null; models?: number; latencyMs?: number; error?: string }> {
    const res = await apiFetch('/api/router/freellmapi/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, key }),
    }, 15_000);
    return res.json() as Promise<{ ok: boolean; status: string; configured: boolean; model?: string | null; models?: number; latencyMs?: number; error?: string }>;
  },

  async getFreeLLMAPIModels(force = false): Promise<{ configured: boolean; models: Array<{ id: string; displayName?: string; provider?: string; capabilities: string[]; modality?: string; free?: boolean; contextLength?: number }>; error?: string }> {
    const res = await apiFetch(`/api/router/freellmapi/models${force ? '?force=1' : ''}`, { method: 'GET' });
    return res.json() as Promise<{ configured: boolean; models: Array<{ id: string; displayName?: string; provider?: string; capabilities: string[]; modality?: string; free?: boolean; contextLength?: number }>; error?: string }>;
  },

  async getProvidersOverview(): Promise<ProvidersOverviewResult> {
    const res = await apiFetch('/api/router/providers', { method: 'GET' });
    if (!res.ok) throw new Error(`Providers overview HTTP ${res.status}`);
    return res.json() as Promise<ProvidersOverviewResult>;
  },

  async getFreeAiProviders(refresh = false): Promise<FreeAiCatalogResult> {
    const res = await apiFetch(`/api/free-ai/providers${refresh ? '?refresh=1' : ''}`, { method: 'GET' }, 15_000);
    return res.json() as Promise<FreeAiCatalogResult>;
  },

  async refreshFreeAiProviders(): Promise<FreeAiCatalogResult & { ok: boolean; error?: string }> {
    const res = await apiFetch('/api/free-ai/refresh', { method: 'POST' }, 15_000);
    return res.json() as Promise<FreeAiCatalogResult & { ok: boolean; error?: string }>;
  },

  async setPairEndpoint(endpoint: string): Promise<{ ok: boolean; endpoint: string }> {
    const res = await apiFetch('/api/router/pair-settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ endpoint }),
    });
    if (!res.ok) throw new Error(`Set PAIR endpoint HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; endpoint: string }>;
  },

  async testPairConnection(): Promise<{ ok: boolean; error?: string }> {
    const res = await apiFetch('/api/router/test/pair', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    }, 15_000);
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  },

  async getGeminiRpm(): Promise<number> {
    const res = await apiFetch('/api/router/gemini-rpm', { method: 'GET' });
    if (!res.ok) return 10;
    const data = await res.json() as { rpm: number };
    return data.rpm ?? 10;
  },

  async setGeminiRpm(rpm: number): Promise<{ ok: boolean; rpm: number }> {
    const res = await apiFetch('/api/router/gemini-rpm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rpm }),
    });
    if (!res.ok) throw new Error(`Set Gemini RPM HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; rpm: number }>;
  },

  async imageStats(): Promise<{ count: number; totalBytes: number; totalMb: number }> {
    const res = await apiFetch('/api/image/stats', { method: 'GET' });
    if (!res.ok) return { count: 0, totalBytes: 0, totalMb: 0 };
    return res.json() as Promise<{ count: number; totalBytes: number; totalMb: number }>;
  },

  async filesIndex(): Promise<FilesIndexResult> {
    const res = await apiFetch('/api/files', { method: 'GET' });
    if (!res.ok) throw new Error(`Files index HTTP ${res.status}`);
    const data = await res.json() as FilesIndexResult;
    return {
      ...data,
      originals: data.originals.map(item => ({
        ...item,
        download_url: item.download_url ? `${BASE}${item.download_url}` : item.download_url,
        detail_url: item.detail_url ? `${BASE}${item.detail_url}` : item.detail_url,
        results_url: item.results_url ? `${BASE}${item.results_url}` : item.results_url,
      })),
      results: data.results.map(item => ({
        ...item,
        download_url: item.download_url ? `${BASE}${item.download_url}` : item.download_url,
        original_detail_url: item.original_detail_url ? `${BASE}${item.original_detail_url}` : item.original_detail_url,
      })),
    };
  },

  async uploadFile(file: File): Promise<{ ok: boolean; original: FileOriginalSummary; preview_kind: string; detail_url: string }> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await apiFetch('/api/files/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Upload file HTTP ${res.status}`);
    }
    const data = await res.json() as { ok: boolean; original: FileOriginalSummary; preview_kind: string; detail_url: string };
    return {
      ...data,
      detail_url: `${BASE}${data.detail_url}`,
      original: {
        ...data.original,
        download_url: data.original.download_url ? `${BASE}${data.original.download_url}` : data.original.download_url,
        detail_url: data.original.detail_url ? `${BASE}${data.original.detail_url}` : data.original.detail_url,
        results_url: data.original.results_url ? `${BASE}${data.original.results_url}` : data.original.results_url,
      },
    };
  },

  async getFileOriginal(id: string): Promise<FileDetailResult> {
    const res = await apiFetch(`/api/files/originals/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!res.ok) throw new Error(`File detail HTTP ${res.status}`);
    const data = await res.json() as FileDetailResult;
    return {
      ...data,
      original: {
        ...data.original,
        download_url: data.original.download_url ? `${BASE}${data.original.download_url}` : data.original.download_url,
        detail_url: data.original.detail_url ? `${BASE}${data.original.detail_url}` : data.original.detail_url,
        results_url: data.original.results_url ? `${BASE}${data.original.results_url}` : data.original.results_url,
      },
      history: data.history.map(item => ({
        ...item,
        download_url: item.download_url ? `${BASE}${item.download_url}` : item.download_url,
        original_detail_url: item.original_detail_url ? `${BASE}${item.original_detail_url}` : item.original_detail_url,
      })),
    };
  },

  async processFile(id: string, competence: string, allowCloud = false): Promise<{ ok: boolean; result: FileResultSummary }> {
    const res = await apiFetch(`/api/files/originals/${encodeURIComponent(id)}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competence, allowCloud }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string; cloud_required?: boolean };
      throw Object.assign(new Error(err.error ?? `Process file HTTP ${res.status}`), { cloud_required: err.cloud_required === true, status: res.status });
    }
    return res.json() as Promise<{ ok: boolean; result: FileResultSummary }>;
  },

  async deleteFileResult(id: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/files/results/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete result HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  async restoreFileResult(id: string): Promise<{ ok: boolean; original: FileOriginalSummary }> {
    const res = await apiFetch(`/api/files/results/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    if (!res.ok) throw new Error(`Restore result HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; original: FileOriginalSummary }>;
  },

  async deleteFileOriginal(id: string, deleteResults = false): Promise<{ ok: boolean; deleted_results: number }> {
    const suffix = deleteResults ? '?deleteResults=true' : '';
    const res = await apiFetch(`/api/files/originals/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Delete file HTTP ${res.status}`);
    }
    return res.json() as Promise<{ ok: boolean; deleted_results: number }>;
  },

  downloadFileOriginalUrl(id: string): string {
    return `${BASE}/api/files/originals/${encodeURIComponent(id)}/download`;
  },

  downloadFileResultUrl(id: string): string {
    return `${BASE}/api/files/results/${encodeURIComponent(id)}/download`;
  },

  async uploadImage(file: File): Promise<{ id: string }> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await apiFetch('/api/image', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `Upload image HTTP ${res.status}`);
    }
    return res.json() as Promise<{ id: string }>;
  },

  async downloadImageFromUrl(url: string): Promise<{ id: string }> {
    const res = await apiFetch('/api/image', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `Download image HTTP ${res.status}`);
    }
    return res.json() as Promise<{ id: string }>;
  },

  async deleteImage(id: string): Promise<void> {
    await apiFetch(`/api/image/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // ── Génération d'images (ComfyUI local + cloud gratuit/quota) ────────────────

  async getImageGenProvidersStatus(): Promise<ImageGenProvidersStatus> {
    const res = await apiFetch('/api/image-generation/providers/status');
    if (!res.ok) throw new Error(`Providers status HTTP ${res.status}`);
    return res.json() as Promise<ImageGenProvidersStatus>;
  },

  async getImageGenSettings(): Promise<ImageGenSettingsResult> {
    const res = await apiFetch('/api/image-generation/settings');
    if (!res.ok) throw new Error(`Image gen settings HTTP ${res.status}`);
    return res.json() as Promise<ImageGenSettingsResult>;
  },

  async setImageGenSettings(updates: Partial<{ comfyui_endpoint: string; priority: 'local' | 'cloud'; free_cloud_only: boolean }>): Promise<ImageGenSettingsResult> {
    const res = await apiFetch('/api/image-generation/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Set image gen settings HTTP ${res.status}`);
    return res.json() as Promise<ImageGenSettingsResult>;
  },

  async setImageCloudKey(id: string, value: string | null): Promise<{ ok: boolean; configured: boolean }> {
    const res = await apiFetch(`/api/image-generation/keys/${encodeURIComponent(id)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Set image cloud key HTTP ${res.status}`);
    return body;
  },

  async generateImage(params: {
    prompt: string; negativePrompt?: string; provider?: string;
    width?: number; height?: number; steps?: number; seed?: number;
  }): Promise<ImageGenerationResult> {
    const res = await apiFetch('/api/image-generation/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error ?? `Generate image HTTP ${res.status}`) as Error & { errorCode?: string };
      err.errorCode = body.error_code;
      throw err;
    }
    return body as ImageGenerationResult;
  },

  async getImageGenerationHistory(): Promise<{ ok: boolean; generations: ImageGenerationRow[] }> {
    const res = await apiFetch('/api/image-generation/history');
    if (!res.ok) throw new Error(`Image generation history HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; generations: ImageGenerationRow[] }>;
  },

  async getImageGeneration(id: string): Promise<{ ok: boolean; generation: ImageGenerationRow }> {
    const res = await apiFetch(`/api/image-generation/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Image generation HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; generation: ImageGenerationRow }>;
  },

  // ── ComfyUI install/lifecycle management ──────────────────────────────────

  async getComfyUiInstall(): Promise<{ ok: boolean; install: ComfyUiInstallState; defaultManagedPath: string; release: ComfyUiReleaseInfo }> {
    const res = await apiFetch('/api/image-generation/comfyui/install');
    if (!res.ok) throw new Error(`ComfyUI install status HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; install: ComfyUiInstallState; defaultManagedPath: string; release: ComfyUiReleaseInfo }>;
  },

  async startComfyUiInstall(destination?: string): Promise<{ ok: boolean; jobId: string; destination: string }> {
    const res = await apiFetch('/api/image-generation/comfyui/install', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(destination ? { destination } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Start ComfyUI install HTTP ${res.status}`);
    return body;
  },

  async useExistingComfyUiInstall(path: string): Promise<{ ok: boolean; install: ComfyUiInstallState }> {
    const res = await apiFetch('/api/image-generation/comfyui/use-existing', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ path }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Use existing ComfyUI install HTTP ${res.status}`);
    return body;
  },

  async detachComfyUiInstall(): Promise<{ ok: boolean; install: ComfyUiInstallState }> {
    const res = await apiFetch('/api/image-generation/comfyui/detach', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Detach ComfyUI install HTTP ${res.status}`);
    return body;
  },

  async startComfyUi(): Promise<{ ok: boolean; install: ComfyUiInstallState }> {
    const res = await apiFetch('/api/image-generation/comfyui/start', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Start ComfyUI HTTP ${res.status}`);
    return body;
  },

  async stopComfyUi(): Promise<{ ok: boolean; install: ComfyUiInstallState }> {
    const res = await apiFetch('/api/image-generation/comfyui/stop', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Stop ComfyUI HTTP ${res.status}`);
    return body;
  },

  async cancelComfyUiInstall(jobId: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/image-generation/comfyui/install/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Cancel install HTTP ${res.status}`);
    return body;
  },

  async uninstallComfyUi(deleteModels: boolean = false): Promise<{ ok: boolean }> {
    const res = await apiFetch('/api/image-generation/comfyui/uninstall', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ deleteModels }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Uninstall ComfyUI HTTP ${res.status}`);
    return body;
  },

  // ── Local model catalog / download / delete ───────────────────────────────

  async getImageModelCatalog(): Promise<{ ok: boolean; catalog: ImageModelCatalogEntry[] }> {
    const res = await apiFetch('/api/image-generation/models/catalog');
    if (!res.ok) throw new Error(`Model catalog HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; catalog: ImageModelCatalogEntry[] }>;
  },

  async downloadImageModel(modelId: string): Promise<{ ok: boolean; jobId: string }> {
    const res = await apiFetch('/api/image-generation/models/download', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ modelId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Download model HTTP ${res.status}`);
    return body;
  },

  async deleteImageModel(filename: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/image-generation/models/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Delete model HTTP ${res.status}`);
    return body;
  },

  async cancelImageModelDownload(jobId: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/image-generation/models/download/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Cancel model download HTTP ${res.status}`);
    return body;
  },

  // ── Vision (analyse d'image 100% locale — jamais de bascule cloud) ──────────

  async visionStatus(): Promise<VisionStatus> {
    const res = await fetchTimeout(`${BASE}/api/vision/status`, { method: 'GET' }, 5_000);
    if (!res.ok) return { model: '', installed: false };
    return res.json() as Promise<VisionStatus>;
  },

  async analyzeImage(imageId: string, question: string): Promise<VisionAnalyzeResult> {
    // Model load + inference can be slow on a 7B vision model — generous timeout.
    const res = await apiFetch('/api/vision/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ imageId, question }),
    }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Analyse image HTTP ${res.status}`);
    }
    return res.json() as Promise<VisionAnalyzeResult>;
  },

  // ── Conversation mode (chat, 100% local — never reaches a cloud provider) ───

  async chatStatus(): Promise<ChatStatus> {
    const res = await fetchTimeout(`${BASE}/api/chat/status`, { method: 'GET' }, 5_000);
    if (!res.ok) return { model: '', installed: false, gpu_busy: false };
    return res.json() as Promise<ChatStatus>;
  },

  async listConversations(): Promise<ChatConversation[]> {
    const res = await apiFetch('/api/chat/conversations', { method: 'GET' });
    if (!res.ok) return [];
    return res.json() as Promise<ChatConversation[]>;
  },

  async createConversation(): Promise<{ id: string }> {
    const res = await apiFetch('/api/chat/conversations', { method: 'POST' });
    if (!res.ok) throw new Error(`Create conversation HTTP ${res.status}`);
    return res.json() as Promise<{ id: string }>;
  },

  async getConversationMessages(id: string): Promise<ChatMessage[]> {
    const res = await apiFetch(`/api/chat/conversations/${encodeURIComponent(id)}/messages`, { method: 'GET' });
    if (!res.ok) return [];
    return res.json() as Promise<ChatMessage[]>;
  },

  async deleteConversation(id: string): Promise<void> {
    await apiFetch(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async sendChatMessage(conversationId: string, message: string): Promise<ChatSendResult> {
    // Model load + inference on a 12B model can be slow, especially cold.
    const res = await apiFetch('/api/chat/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conversationId, message }),
    }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Chat HTTP ${res.status}`);
    }
    return res.json() as Promise<ChatSendResult>;
  },

  async listPreferenceFacts(): Promise<PreferenceFact[]> {
    const res = await apiFetch('/api/chat/preferences', { method: 'GET' });
    if (!res.ok) return [];
    return res.json() as Promise<PreferenceFact[]>;
  },

  async addPreferenceFact(fact: string): Promise<PreferenceFact> {
    const res = await apiFetch('/api/chat/preferences', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fact }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Add preference HTTP ${res.status}`);
    }
    return res.json() as Promise<PreferenceFact>;
  },

  async updatePreferenceFact(id: string, fact: string): Promise<void> {
    const res = await apiFetch(`/api/chat/preferences/${encodeURIComponent(id)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fact }),
    });
    if (!res.ok) throw new Error(`Update preference HTTP ${res.status}`);
  },

  async deletePreferenceFact(id: string): Promise<void> {
    await apiFetch(`/api/chat/preferences/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async clearPreferenceFacts(): Promise<void> {
    await apiFetch('/api/chat/preferences', { method: 'DELETE' });
  },

  // ── Candidature (100% local — personal CV data never sent to cloud) ─────────

  async cvAnalyze(cvContent: string, powerful = false): Promise<{ report: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cv_content: cvContent, powerful }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV analyze HTTP ${res.status}`);
    }
    return res.json() as Promise<{ report: string; model_used: string }>;
  },

  async cvRewrite(params: {
    cvContent: string;
    targetJob?: string;
    jobOffer?:  string;
    powerful?:  boolean;
  }): Promise<{ rewritten_cv: string; changes: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/rewrite', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        cv_content: params.cvContent,
        target_job: params.targetJob,
        job_offer:  params.jobOffer,
        powerful:   params.powerful ?? false,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV rewrite HTTP ${res.status}`);
    }
    return res.json() as Promise<{ rewritten_cv: string; changes: string; model_used: string }>;
  },

  async cvLetter(params: {
    cvContent: string;
    format: 'email' | 'lettre';
    mode: 'generique' | 'ciblee';
    company?: string;
    jobTitle?: string;
    jobOffer?: string;
    powerful?: boolean;
  }): Promise<{ letter: string; title: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/letter', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        cv_content: params.cvContent,
        format:     params.format,
        mode:       params.mode,
        company:    params.company,
        job_title:  params.jobTitle,
        job_offer:  params.jobOffer,
        powerful:   params.powerful ?? false,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV letter HTTP ${res.status}`);
    }
    return res.json() as Promise<{ letter: string; title: string; model_used: string }>;
  },

  async cvTargetJobs(cvContent: string, powerful = false): Promise<{ report: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/target-jobs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cv_content: cvContent, powerful }),
    }, 180_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV target-jobs HTTP ${res.status}`);
    }
    return res.json() as Promise<{ report: string; model_used: string }>;
  },

  async cvAtsKeywords(cvContent: string, powerful = false): Promise<{ report: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/ats-keywords', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cv_content: cvContent, powerful }),
    }, 180_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV ats-keywords HTTP ${res.status}`);
    }
    return res.json() as Promise<{ report: string; model_used: string }>;
  },

  async cvMasterCv(cvContent: string, powerful = false): Promise<{ master_cv: string; guide: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/master-cv', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cv_content: cvContent, powerful }),
    }, 240_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV master-cv HTTP ${res.status}`);
    }
    return res.json() as Promise<{ master_cv: string; guide: string; model_used: string }>;
  },

  async cvAdaptCv(params: {
    masterCvContent: string;
    jobOffer: string;
    powerful?: boolean;
  }): Promise<{ adequation_score: string; adapted_cv: string; missing: string; keywords_used: string; model_used: string }> {
    const res = await apiFetch('/api/candidature/adapt-cv', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ master_cv_content: params.masterCvContent, job_offer: params.jobOffer, powerful: params.powerful }),
    }, 240_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV adapt HTTP ${res.status}`);
    }
    return res.json() as Promise<{ adequation_score: string; adapted_cv: string; missing: string; keywords_used: string; model_used: string }>;
  },

  async cvFreeQuestion(params: {
    cvContent: string;
    question: string;
    chainHistory?: { question: string; answer: string }[];
    powerful?: boolean;
  }): Promise<{ answer: string; model_used: string; context_chars_estimate: number; context_tokens_estimate: number; context_warning: boolean }> {
    const res = await apiFetch('/api/candidature/free-question', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        cv_content:     params.cvContent,
        question:       params.question,
        chain_history:  params.chainHistory ?? [],
        powerful:       params.powerful ?? false,
      }),
    }, 180_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV free-question HTTP ${res.status}`);
    }
    return res.json() as Promise<{ answer: string; model_used: string; context_chars_estimate: number; context_tokens_estimate: number; context_warning: boolean }>;
  },

  async cvGetSavedPrompts(): Promise<{ prompts: CandidatureSavedPrompt[] }> {
    const res = await apiFetch('/api/candidature/prompts', { method: 'GET' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV prompts list HTTP ${res.status}`);
    }
    return res.json() as Promise<{ prompts: CandidatureSavedPrompt[] }>;
  },

  async cvCreateSavedPrompt(name: string, promptText: string): Promise<{ prompt: CandidatureSavedPrompt }> {
    const res = await apiFetch('/api/candidature/prompts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, prompt_text: promptText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV prompt create HTTP ${res.status}`);
    }
    return res.json() as Promise<{ prompt: CandidatureSavedPrompt }>;
  },

  async cvUpdateSavedPrompt(id: string, updates: { name?: string; promptText?: string }): Promise<{ prompt: CandidatureSavedPrompt }> {
    const res = await apiFetch(`/api/candidature/prompts/${encodeURIComponent(id)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: updates.name, prompt_text: updates.promptText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV prompt update HTTP ${res.status}`);
    }
    return res.json() as Promise<{ prompt: CandidatureSavedPrompt }>;
  },

  async cvDeleteSavedPrompt(id: string): Promise<void> {
    const res = await apiFetch(`/api/candidature/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV prompt delete HTTP ${res.status}`);
    }
  },

  async cvReorderSavedPrompts(orderedIds: string[]): Promise<{ prompts: CandidatureSavedPrompt[] }> {
    const res = await apiFetch('/api/candidature/prompts/reorder', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ordered_ids: orderedIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV prompts reorder HTTP ${res.status}`);
    }
    return res.json() as Promise<{ prompts: CandidatureSavedPrompt[] }>;
  },

  async cvTouchSavedPrompt(id: string): Promise<{ prompt: CandidatureSavedPrompt }> {
    const res = await apiFetch(`/api/candidature/prompts/${encodeURIComponent(id)}/touch`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `CV prompt touch HTTP ${res.status}`);
    }
    return res.json() as Promise<{ prompt: CandidatureSavedPrompt }>;
  },

  // ── CV import from PDF (100% local — personal CV data never sent to cloud) ───

  async importCvFromPdf(file: File): Promise<{ title: string; text: string; pages_count: number }> {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('filename', file.name);
    const res = await apiFetch('/api/cv/import-pdf', { method: 'POST', body: fd }, 30_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `Import PDF HTTP ${res.status}`);
    }
    return res.json() as Promise<{ title: string; text: string; pages_count: number }>;
  },

  // ── Agents ────────────────────────────────────────────────────────────────────

  async listAgentTypes(): Promise<AgentTypeInfo[]> {
    const res = await apiFetch('/api/agents/types', { method: 'GET' });
    if (!res.ok) throw new Error(`Agent types HTTP ${res.status}`);
    return res.json() as Promise<AgentTypeInfo[]>;
  },

  async listAgents(): Promise<Agent[]> {
    const res = await apiFetch('/api/agents', { method: 'GET' });
    if (!res.ok) throw new Error(`Agents HTTP ${res.status}`);
    return res.json() as Promise<Agent[]>;
  },

  async createAgent(data: AgentCreate): Promise<Agent> {
    const res = await apiFetch('/api/agents', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error);
    }
    return res.json() as Promise<Agent>;
  },

  async updateAgent(id: string, data: Partial<AgentCreate>): Promise<Agent> {
    const res = await apiFetch(`/api/agents/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error);
    }
    return res.json() as Promise<Agent>;
  },

  async deleteAgent(id: string): Promise<void> {
    const res = await apiFetch(`/api/agents/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete agent HTTP ${res.status}`);
  },

  async runAgent(id: string): Promise<AgentRunOutput> {
    const res = await apiFetch(`/api/agents/${id}/run`, { method: 'POST' }, 6 * 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string; strict_local?: boolean; no_key?: boolean };
      throw Object.assign(new Error(err.error), { strict_local: err.strict_local, no_key: err.no_key });
    }
    return res.json() as Promise<AgentRunOutput>;
  },

  async getAgentRuns(id: string): Promise<AgentRun[]> {
    const res = await apiFetch(`/api/agents/${id}/runs`, { method: 'GET' });
    if (!res.ok) throw new Error(`Agent runs HTTP ${res.status}`);
    return res.json() as Promise<AgentRun[]>;
  },

  async getPendingAgentOutputs(): Promise<AgentOutput[]> {
    const res = await apiFetch('/api/agents/pending-outputs', { method: 'GET' });
    if (!res.ok) throw new Error(`Pending outputs HTTP ${res.status}`);
    return res.json() as Promise<AgentOutput[]>;
  },

  async consumeAgentOutput(id: string, neuronId: string): Promise<void> {
    const res = await apiFetch(`/api/agents/pending-outputs/${id}/consume`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ neuron_id: neuronId }),
    });
    if (!res.ok) throw new Error(`Consume output HTTP ${res.status}`);
  },

  // ── Résumé de vidéo longue ───────────────────────────────────────────────────

  async estimateVideoSummary(url: string): Promise<VideoEstimate> {
    const res = await apiFetch('/api/video-summary/estimate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    }, 30_000);
    const data = await res.json() as VideoEstimate & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Estimate HTTP ${res.status}`);
    return data;
  },

  async createVideoSummaryJob(data: VideoSummaryCreate): Promise<{ jobId: string }> {
    const res = await apiFetch('/api/video-summary/jobs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Video summary job HTTP ${res.status}`);
    return body as { jobId: string };
  },

  async listVideoSummaryJobs(): Promise<VideoJob[]> {
    const res = await apiFetch('/api/video-summary/jobs', { method: 'GET' });
    if (!res.ok) throw new Error(`Video summary jobs HTTP ${res.status}`);
    const data = await res.json() as { jobs: VideoJob[] };
    return data.jobs;
  },

  async getVideoSummaryJob(id: string): Promise<VideoJobDetail> {
    const res = await apiFetch(`/api/video-summary/jobs/${id}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Video summary job HTTP ${res.status}`);
    return res.json() as Promise<VideoJobDetail>;
  },

  async resumeVideoSummaryJob(id: string): Promise<void> {
    const res = await apiFetch(`/api/video-summary/jobs/${id}/resume`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Resume HTTP ${res.status}`);
  },

  async cancelVideoSummaryJob(id: string): Promise<void> {
    const res = await apiFetch(`/api/video-summary/jobs/${id}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error(`Cancel HTTP ${res.status}`);
  },

  async deleteVideoSummaryJob(id: string): Promise<void> {
    const res = await apiFetch(`/api/video-summary/jobs/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete HTTP ${res.status}`);
  },

  async getOpenMontageStatus(): Promise<{ status: OpenMontageStatus }> {
    const res = await apiFetch('/api/openmontage/status', { method: 'GET' });
    if (!res.ok) throw new Error(`OpenMontage status HTTP ${res.status}`);
    return res.json() as Promise<{ status: OpenMontageStatus }>;
  },

  async getOpenMontageCapabilities(): Promise<OpenMontageCapabilities> {
    const res = await apiFetch('/api/openmontage/capabilities', { method: 'GET' });
    if (!res.ok) throw new Error(`OpenMontage capabilities HTTP ${res.status}`);
    return res.json() as Promise<OpenMontageCapabilities>;
  },

  async startOpenMontageRender(data: OpenMontageRenderRequest): Promise<{ jobId: string }> {
    const res = await apiFetch('/api/openmontage/render', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `OpenMontage render HTTP ${res.status}`);
    return body as { jobId: string };
  },

  async getOpenMontageJob(id: string): Promise<OpenMontageJob> {
    const res = await apiFetch(`/api/openmontage/job/${id}`, { method: 'GET' });
    if (!res.ok) throw new Error(`OpenMontage job HTTP ${res.status}`);
    return res.json() as Promise<OpenMontageJob>;
  },

  async cancelOpenMontageJob(id: string): Promise<void> {
    const res = await apiFetch(`/api/openmontage/job/${id}/cancel`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    });
    if (!res.ok) throw new Error(`OpenMontage cancel HTTP ${res.status}`);
  },

  getOpenMontageArtifactUrl(id: string): string {
    return `${BASE}/api/openmontage/job/${id}/artifact`;
  },

  // ── Persona ───────────────────────────────────────────────────────────────────

  async getPersonaSettings(): Promise<PersonaSettings> {
    const res = await apiFetch('/api/persona/settings', { method: 'GET' });
    if (!res.ok) throw new Error(`Persona settings HTTP ${res.status}`);
    return res.json() as Promise<PersonaSettings>;
  },

  async updatePersonaSettings(updates: Partial<PersonaSettings>): Promise<PersonaSettings> {
    const res = await apiFetch('/api/persona/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Persona settings update HTTP ${res.status}`);
    return res.json() as Promise<PersonaSettings>;
  },

  // ── Inbox (dossier surveillé) ─────────────────────────────────────────────────

  async getInboxSettings(): Promise<InboxSettings> {
    const res = await apiFetch('/api/inbox/settings', { method: 'GET' });
    if (!res.ok) throw new Error(`Inbox settings HTTP ${res.status}`);
    return res.json() as Promise<InboxSettings>;
  },

  async updateInboxSettings(updates: Partial<InboxSettings>): Promise<InboxSettings> {
    const res = await apiFetch('/api/inbox/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Inbox settings update HTTP ${res.status}`);
    return res.json() as Promise<InboxSettings>;
  },

  async checkInboxNow(): Promise<InboxCheckResult> {
    const res = await apiFetch('/api/inbox/check', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
      throw new Error(err.error ?? `Inbox check HTTP ${res.status}`);
    }
    return res.json() as Promise<InboxCheckResult>;
  },

  async getInboxPending(): Promise<InboxPending[]> {
    const res = await apiFetch('/api/inbox/pending', { method: 'GET' });
    if (!res.ok) throw new Error(`Inbox pending HTTP ${res.status}`);
    return res.json() as Promise<InboxPending[]>;
  },

  async consumeInboxPending(id: string): Promise<void> {
    const res = await apiFetch(`/api/inbox/pending/${id}/consume`, { method: 'POST' });
    if (!res.ok) throw new Error(`Inbox consume HTTP ${res.status}`);
  },

  async backupList(): Promise<BackupListResult> {
    const res = await apiFetch('/api/backup/list', { method: 'GET' });
    if (!res.ok) throw new Error(`Backup list HTTP ${res.status}`);
    return res.json() as Promise<BackupListResult>;
  },

  async backupExport(): Promise<BackupExport> {
    const res = await apiFetch('/api/backup/export', { method: 'GET' });
    if (!res.ok) throw new Error(`Backup export HTTP ${res.status}`);
    return res.json() as Promise<BackupExport>;
  },

  async backupTrigger(): Promise<{ ok: boolean; filename: string; neurons_count: number; exported_at: string }> {
    const res = await apiFetch('/api/backup/trigger', { method: 'POST' });
    if (!res.ok) throw new Error(`Backup trigger HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; filename: string; neurons_count: number; exported_at: string }>;
  },

  async backupImport(data: BackupExport): Promise<ImportResult> {
    const res = await apiFetch('/api/backup/import', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Backup import HTTP ${res.status}`);
    return res.json() as Promise<ImportResult>;
  },

  // ── Corpus de référence ──────────────────────────────────────────────────

  async corpusScan(files: File[], filters: CorpusFilters): Promise<CorpusScanResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (filters.keywords) fd.append('keywords', filters.keywords);
    if (filters.minSize !== undefined) fd.append('minSize', String(filters.minSize));
    if (filters.maxSize !== undefined) fd.append('maxSize', String(filters.maxSize));
    if (filters.limit   !== undefined) fd.append('limit', String(filters.limit));
    const res = await apiFetch('/api/corpus/scan', { method: 'POST', body: fd }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Corpus scan HTTP ${res.status}`);
    }
    return res.json() as Promise<CorpusScanResult>;
  },

  async corpusImport(files: File[], corpusName: string, filters: CorpusFilters): Promise<CorpusImportResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('corpusName', corpusName);
    if (filters.keywords) fd.append('keywords', filters.keywords);
    if (filters.minSize !== undefined) fd.append('minSize', String(filters.minSize));
    if (filters.maxSize !== undefined) fd.append('maxSize', String(filters.maxSize));
    if (filters.limit   !== undefined) fd.append('limit', String(filters.limit));
    const res = await apiFetch('/api/corpus/import', { method: 'POST', body: fd }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Corpus import HTTP ${res.status}`);
    }
    return res.json() as Promise<CorpusImportResult>;
  },

  async corpusSearchCapture(subject: string, urls: string[]): Promise<CorpusImportResult> {
    const res = await apiFetch('/api/corpus/search-capture', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, urls }),
    }, 30_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Corpus search-capture HTTP ${res.status}`);
    }
    return res.json() as Promise<CorpusImportResult>;
  },

  async corpusJobStatus(jobId: string): Promise<CorpusJobStatus> {
    const res = await apiFetch(`/api/corpus/jobs/${jobId}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Corpus job HTTP ${res.status}`);
    return res.json() as Promise<CorpusJobStatus>;
  },

  async corpusList(): Promise<{ corpora: CorpusSource[] }> {
    const res = await apiFetch('/api/corpus/list', { method: 'GET' });
    if (!res.ok) throw new Error(`Corpus list HTTP ${res.status}`);
    return res.json() as Promise<{ corpora: CorpusSource[] }>;
  },

  async corpusSummarize(neuronId: string): Promise<{ ok: boolean; summary: string; model_used: string; truncated: boolean }> {
    const res = await apiFetch(`/api/corpus/summarize/${neuronId}`, { method: 'POST' }, 90_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Corpus summarize HTTP ${res.status}`);
    }
    return res.json() as Promise<{ ok: boolean; summary: string; model_used: string; truncated: boolean }>;
  },

  async corpusDelete(id: string): Promise<{ ok: boolean; deleted: number }> {
    const res = await apiFetch(`/api/corpus/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Corpus delete HTTP ${res.status}`);
    }
    return res.json() as Promise<{ ok: boolean; deleted: number }>;
  },

  // ── Journal d'activité — 100% local, jamais synchronisé ni exporté avec le backup ──

  async activityLog(filters: ActivityLogFilters = {}): Promise<{ rows: ActivityLogEntry[]; total: number }> {
    const params = new URLSearchParams();
    if (filters.opType) params.set('opType', filters.opType);
    if (filters.result) params.set('result', filters.result);
    if (filters.from)   params.set('from', filters.from);
    if (filters.to)     params.set('to', filters.to);
    if (filters.q)      params.set('q', filters.q);
    params.set('limit',  String(filters.limit  ?? 50));
    params.set('offset', String(filters.offset ?? 0));
    const res = await apiFetch(`/api/activity/log?${params.toString()}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Activity log HTTP ${res.status}`);
    return res.json() as Promise<{ rows: ActivityLogEntry[]; total: number }>;
  },

  async activityOpTypes(): Promise<string[]> {
    const res = await apiFetch('/api/activity/op-types', { method: 'GET' });
    if (!res.ok) return [];
    const data = await res.json() as { opTypes: string[] };
    return data.opTypes ?? [];
  },

  async activityStats(): Promise<{ count: number; sizeBytes: number; retentionDays: number }> {
    const res = await apiFetch('/api/activity/stats', { method: 'GET' });
    if (!res.ok) throw new Error(`Activity stats HTTP ${res.status}`);
    return res.json() as Promise<{ count: number; sizeBytes: number; retentionDays: number }>;
  },

  async setActivityRetention(days: number): Promise<{ ok: boolean; retentionDays: number; purged: number }> {
    const res = await apiFetch('/api/activity/retention', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ days }),
    });
    if (!res.ok) throw new Error(`Activity retention HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; retentionDays: number; purged: number }>;
  },

  async clearActivityLog(): Promise<{ ok: boolean; deleted: number }> {
    const res = await apiFetch('/api/activity/log', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ confirm: true }),
    });
    if (!res.ok) throw new Error(`Activity clear HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; deleted: number }>;
  },

  async exportActivityLog(): Promise<{ exported_at: string; count: number; warning: string; entries: ActivityLogEntry[] }> {
    const res = await apiFetch('/api/activity/export', { method: 'GET' }, 30_000);
    if (!res.ok) throw new Error(`Activity export HTTP ${res.status}`);
    return res.json() as Promise<{ exported_at: string; count: number; warning: string; entries: ActivityLogEntry[] }>;
  },

  async reviewResearch(content: string): Promise<{ review: string; model: string }> {
    const res = await apiFetch('/api/research/review', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content }),
    }, 90_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Review HTTP ${res.status}`);
    }
    return res.json() as Promise<{ review: string; model: string }>;
  },

  async research(subject: string, mode: 'synthese' | 'actualite', detailLevel?: DetailLevel, style?: StyleExampleOptions): Promise<ResearchResult> {
    const res = await apiFetch('/api/research', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, mode, detailLevel, ...style }),
    }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Research HTTP ${res.status}`);
    }
    return res.json() as Promise<ResearchResult>;
  },

  async regenerateVeille(
    subject: string, detailLevel: DetailLevel, sources: ResearchSource[] = [],
    style?: StyleExampleOptions & { feedback?: string; bad_output?: string },
  ): Promise<{ content: string; model: string; detailLevel: DetailLevel; sources: ResearchSource[]; usedExamples?: StyleExampleUsed[] }> {
    const res = await apiFetch('/api/research/regenerate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, detailLevel, sources, ...style }),
    }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string; quota?: boolean };
      throw Object.assign(new Error(err.error ?? `Regenerate HTTP ${res.status}`), { quota: err.quota });
    }
    return res.json() as Promise<{ content: string; model: string; detailLevel: DetailLevel; sources: ResearchSource[]; usedExamples?: StyleExampleUsed[] }>;
  },

  async getVeilleSettings(): Promise<VeilleSettings> {
    try {
      const res = await apiFetch('/api/research/settings', { method: 'GET' });
      if (!res.ok) return { detailLevel: 'synthese' };
      return res.json() as Promise<VeilleSettings>;
    } catch {
      return { detailLevel: 'synthese' };
    }
  },

  async setVeilleSettings(detailLevel: DetailLevel): Promise<VeilleSettings> {
    const res = await apiFetch('/api/research/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ detailLevel }),
    });
    if (!res.ok) throw new Error(`Veille settings HTTP ${res.status}`);
    return res.json() as Promise<VeilleSettings>;
  },

  async getStyleExampleSettings(): Promise<StyleExampleSettings> {
    try {
      const res = await apiFetch('/api/style-examples/settings', { method: 'GET' });
      if (!res.ok) return { enabled: false };
      return res.json() as Promise<StyleExampleSettings>;
    } catch {
      return { enabled: false };
    }
  },

  async setStyleExampleSettings(enabled: boolean): Promise<StyleExampleSettings> {
    const res = await apiFetch('/api/style-examples/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`Style example settings HTTP ${res.status}`);
    return res.json() as Promise<StyleExampleSettings>;
  },

  async getStyleExampleTypes(): Promise<string[]> {
    try {
      const res = await apiFetch('/api/style-examples/types', { method: 'GET' });
      if (!res.ok) return [];
      const data = await res.json() as { types?: string[] };
      return data.types ?? [];
    } catch {
      return [];
    }
  },

  async saveAsStyleExample(params: { title?: string; content: string; type: string; source_excerpt?: string }): Promise<{ id: string }> {
    const res = await apiFetch('/api/style-examples/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Save style example HTTP ${res.status}`);
    }
    return res.json() as Promise<{ id: string }>;
  },

  async regenerateSummaryWithFeedback(params: { original_prompt: string; bad_output?: string; feedback: string }): Promise<{ summary: string; model_used: string }> {
    const res = await apiFetch('/api/style-examples/regenerate-with-feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Regenerate with feedback HTTP ${res.status}`);
    }
    return res.json() as Promise<{ summary: string; model_used: string }>;
  },

  async getResearchQuota(): Promise<ResearchQuota> {
    try {
      const res = await apiFetch('/api/research/quota', { method: 'GET' });
      if (!res.ok) return { groundingUsed: 0, groundingLimit: 20, groundingRemaining: 20 };
      return res.json() as Promise<ResearchQuota>;
    } catch {
      return { groundingUsed: 0, groundingLimit: 20, groundingRemaining: 20 };
    }
  },

  async deepResearchPlan(subject: string, depth: number): Promise<DeepResearchPlanResult> {
    const res = await apiFetch('/api/research/deep/plan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, depth }),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Plan HTTP ${res.status}`);
    }
    return res.json() as Promise<DeepResearchPlanResult>;
  },

  async deepResearchSection(
    subject:     string,
    subtopic:    string,
    index:       number,
    total:       number,
    source:      'ia' | 'web',
    otherTopics: string[],
    detailLevel?: DetailLevel,
  ): Promise<DeepResearchSectionResult> {
    const res = await apiFetch('/api/research/deep/section', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, subtopic, index, total, source, otherTopics, detailLevel }),
    }, 120_000);
    if (!res.ok) {
      const raw = await res.json().catch(() => ({})) as { error?: string; quota?: boolean };
      const e   = new Error(raw.error ?? `Section HTTP ${res.status}`) as Error & { quota?: boolean };
      if (raw.quota) e.quota = true;
      throw e;
    }
    return res.json() as Promise<DeepResearchSectionResult>;
  },

  async deepResearchDocument(
    subject: string,
    depth:   number,
    source:  'ia' | 'web',
    detailLevel?: DetailLevel,
  ): Promise<DeepResearchSectionResult> {
    const res = await apiFetch('/api/research/deep/document', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, depth, source, detailLevel }),
    }, 180_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Document HTTP ${res.status}`);
    }
    return res.json() as Promise<DeepResearchSectionResult>;
  },

  // ── Multi-source research ─────────────────────────────────────────────────────

  async multiResearchPlan(subject: string, angles: number): Promise<{ angles: string[]; model: string }> {
    const res = await apiFetch('/api/research/multi/plan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, angles }),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string; quota?: boolean; no_key?: boolean };
      throw Object.assign(new Error(err.error ?? `Plan HTTP ${res.status}`), { quota: err.quota, no_key: err.no_key });
    }
    return res.json() as Promise<{ angles: string[]; model: string }>;
  },

  async multiResearchSource(subject: string, angle: string, detailLevel?: DetailLevel): Promise<{ content: string; model: string; sources: ResearchSource[]; angle: string }> {
    const res = await apiFetch('/api/research/multi/source', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, angle, detailLevel }),
    }, 90_000);
    if (!res.ok) {
      const raw = await res.json().catch(() => ({})) as { error?: string; quota?: boolean; grounding_unavailable?: boolean };
      throw Object.assign(new Error(raw.error ?? `Source HTTP ${res.status}`), { quota: raw.quota, grounding_unavailable: raw.grounding_unavailable });
    }
    return res.json() as Promise<{ content: string; model: string; sources: ResearchSource[]; angle: string }>;
  },

  async multiResearchCrosscheck(subject: string, sources: Array<{ angle: string; content: string }>, detailLevel?: DetailLevel): Promise<{ synthesis: string; model: string }> {
    const res = await apiFetch('/api/research/multi/crosscheck', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, sources, detailLevel }),
    }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string; quota?: boolean };
      throw Object.assign(new Error(err.error ?? `Crosscheck HTTP ${res.status}`), { quota: err.quota });
    }
    return res.json() as Promise<{ synthesis: string; model: string }>;
  },

  // ── Site shortcuts ──────────────────────────────────────────────────────────

  async getShortcuts(): Promise<Record<string, string>> {
    try {
      const res = await apiFetch('/api/shortcuts', { method: 'GET' });
      if (!res.ok) return {};
      return res.json() as Promise<Record<string, string>>;
    } catch {
      return {};
    }
  },

  async setShortcut(name: string, url: string): Promise<Record<string, string>> {
    const res = await apiFetch('/api/shortcuts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Shortcut HTTP ${res.status}`);
    }
    return (await res.json() as { shortcuts: Record<string, string> }).shortcuts;
  },

  async deleteShortcut(name: string): Promise<Record<string, string>> {
    const res = await apiFetch(`/api/shortcuts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) return {};
    return (await res.json() as { shortcuts: Record<string, string> }).shortcuts;
  },

  // ── PDF export ──────────────────────────────────────────────────────────────

  async exportNeuronPdf(id: string, mode: 'basic' | 'complete'): Promise<Blob> {
    const res = await apiFetch('/api/pdf/neuron', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, mode }),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `PDF export HTTP ${res.status}`);
    }
    return res.blob();
  },

  async exportSubjectPdf(subject: string, mode: 'basic' | 'complete'): Promise<Blob> {
    const res = await apiFetch('/api/pdf/subject', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, mode }),
    }, 90_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `PDF subject export HTTP ${res.status}`);
    }
    return res.blob();
  },

  async clarify(question: string): Promise<ClarifyResult> {
    try {
      const res = await apiFetch('/api/clarify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question }),
      }, 30_000);
      if (!res.ok) return { needs_clarification: false };
      return res.json() as Promise<ClarifyResult>;
    } catch {
      return { needs_clarification: false };
    }
  },

  async answer(
    question: string,
    opts: {
      max_context?:           number;
      force_local_powerful?:  boolean;
      clarification_context?: Array<{ question: string; answer: string }>;
      scope?:                 CorpusScope;
      kiwix_scope?:           KiwixSearchScope;
      // NB-7: Docteur Memory. use_memory:false ⇒ the server makes ZERO memory calls. Project / notebook are EXPLICIT selections, never guessed.
      use_memory?:            boolean;
      memory_project?:        string | null;
      memory_notebook?:       string | null;
    } = {},
  ): Promise<AnswerResult> {
    const timeout = opts.force_local_powerful ? 180_000 : TIMEOUT_ANSWER;
    const res = await apiFetch('/api/answer', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, ...opts }),
    }, timeout);
    if (!res.ok) throw new Error(`Answer HTTP ${res.status}`);
    return res.json() as Promise<AnswerResult>;
  },

  // ── Privacy guard ─────────────────────────────────────────────────────────

  async privacyViolations(limit = 100): Promise<{ violations: PrivacyViolation[] }> {
    const res = await apiFetch(`/api/privacy/violations?limit=${limit}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Privacy violations HTTP ${res.status}`);
    return res.json() as Promise<{ violations: PrivacyViolation[] }>;
  },

  async privacyTest(): Promise<PrivacyTestResult> {
    const res = await apiFetch('/api/privacy/test', { method: 'POST' });
    if (!res.ok) throw new Error(`Privacy test HTTP ${res.status}`);
    return res.json() as Promise<PrivacyTestResult>;
  },

  // ── Connectors (YouTube / Google Drive / OneDrive) ──────────────────────────
  // Settings → Connexions UI only. No real OAuth is ever triggered by these
  // calls except connectAuthUrl(), which merely builds a consent URL string —
  // it does not open it. Nothing here reads back a stored secret value.

  async listConnectors(): Promise<ConnectorsListResult> {
    const res = await apiFetch('/api/connectors', { method: 'GET' });
    if (!res.ok) throw new Error(`Connectors HTTP ${res.status}`);
    return res.json() as Promise<ConnectorsListResult>;
  },

  async saveConnectorCredentials(provider: ConnectorId, clientId: string, clientSecret: string): Promise<{ ok: boolean; client_configured: boolean }> {
    const res = await apiFetch(`/api/connectors/${encodeURIComponent(provider)}/client-credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Connector credentials HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; client_configured: boolean }>;
  },

  async deleteConnectorCredentials(provider: ConnectorId): Promise<{ ok: boolean; client_configured: boolean }> {
    const res = await apiFetch(`/api/connectors/${encodeURIComponent(provider)}/client-credentials`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Connector credentials delete HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; client_configured: boolean }>;
  },

  async disconnectConnector(provider: ConnectorId): Promise<{ ok: boolean; disconnected: boolean; deleted_pages: number }> {
    const res = await apiFetch(`/api/connectors/${encodeURIComponent(provider)}/disconnect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Connector disconnect HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; disconnected: boolean; deleted_pages: number }>;
  },

  // ── Adaptive memory (Phase 3) ───────────────────────────────────────────────

  async getMemorySettings(): Promise<MemorySettings> {
    const res = await apiFetch('/api/memory/settings', { method: 'GET' });
    if (!res.ok) throw new Error(`Memory settings HTTP ${res.status}`);
    return res.json() as Promise<MemorySettings>;
  },

  async updateMemorySettings(updates: Partial<MemorySettings>): Promise<MemorySettings> {
    const res = await apiFetch('/api/memory/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Memory settings update HTTP ${res.status}`);
    return res.json() as Promise<MemorySettings>;
  },

  async getMemoryItems(): Promise<MemoryItemsResult> {
    const res = await apiFetch('/api/memory/items', { method: 'GET' });
    if (!res.ok) throw new Error(`Memory items HTTP ${res.status}`);
    return res.json() as Promise<MemoryItemsResult>;
  },

  async previewMemory(query?: string): Promise<MemoryPreviewResult> {
    const qs = query ? `?${new URLSearchParams({ query })}` : '';
    const res = await apiFetch(`/api/memory/preview${qs}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Memory preview HTTP ${res.status}`);
    return res.json() as Promise<MemoryPreviewResult>;
  },

  async deleteMemoryItem(tier: 'long_term' | 'episodic', id: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/memory/items/${tier}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Memory delete HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  async resetAdaptiveMemory(): Promise<{ ok: boolean }> {
    const res = await apiFetch('/api/memory/reset', { method: 'POST' });
    if (!res.ok) throw new Error(`Memory reset HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  // ── Local Notebook (Phase 5) ────────────────────────────────────────────────

  async listNotebooks(): Promise<{ notebooks: Notebook[] }> {
    const res = await apiFetch('/api/notebooks', { method: 'GET' });
    if (!res.ok) throw new Error(`Notebooks HTTP ${res.status}`);
    return res.json() as Promise<{ notebooks: Notebook[] }>;
  },

  async createNotebook(title: string, description = ''): Promise<{ id: string }> {
    const res = await apiFetch('/api/notebooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description }),
    });
    if (!res.ok) throw new Error(`Notebook creation HTTP ${res.status}`);
    return res.json() as Promise<{ id: string }>;
  },

  async getNotebook(id: string): Promise<{ notebook: Notebook; source_count: number }> {
    const res = await apiFetch(`/api/notebooks/${id}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Notebook HTTP ${res.status}`);
    return res.json() as Promise<{ notebook: Notebook; source_count: number }>;
  },

  async deleteNotebook(id: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/notebooks/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Notebook delete HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  async listNotebookSources(notebookId: string, limit = 100, offset = 0): Promise<{ sources: NotebookSource[]; total: number }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/sources?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Notebook sources HTTP ${res.status}`);
    return res.json() as Promise<{ sources: NotebookSource[]; total: number }>;
  },

  async addNotebookSource(notebookId: string, source: { source_id: string; title: string; kind?: string; source_type?: string; provenance?: string }): Promise<{ id: string; notebook_privacy: { privacy: boolean; egressPolicy: string } }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/sources`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source),
    });
    if (!res.ok) throw new Error(`Notebook add source HTTP ${res.status}`);
    return res.json() as Promise<{ id: string; notebook_privacy: { privacy: boolean; egressPolicy: string } }>;
  },

  async removeNotebookSource(notebookId: string, sourceRowId: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/sources/${sourceRowId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Notebook remove source HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  async askNotebook(notebookId: string, question: string): Promise<NotebookAskResult> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }),
    }, 60_000);
    if (!res.ok) throw new Error(`Notebook ask HTTP ${res.status}`);
    return res.json() as Promise<NotebookAskResult>;
  },

  async getNotebookSummary(notebookId: string): Promise<NotebookSummaryResult> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/summary`, { method: 'GET' }, 60_000);
    if (!res.ok) throw new Error(`Notebook summary HTTP ${res.status}`);
    return res.json() as Promise<NotebookSummaryResult>;
  },

  // "Préparer pour NotebookLM" — writes a local .md file only, never
  // contacts Google. Returns 409 with requires_confirmation:true if the
  // notebook is local_only and confirm wasn't passed.
  async exportNotebookForNotebookLm(notebookId: string, confirm = false): Promise<{ ok: boolean; filename: string; source_count: number; notice: string }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/export-for-notebooklm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }),
    });
    if (res.status === 409) {
      const body = await res.json();
      const err = new Error(body.error) as Error & { requiresConfirmation?: boolean };
      err.requiresConfirmation = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Notebook export HTTP ${res.status}`);
    return res.json();
  },

  // ── Notebook NB-2 — raw documents (strict local, FTS5 + vector) ─────────────
  async listNotebookDocuments(notebookId: string, page: { limit?: number; offset?: number } = {}): Promise<{ strict_local: boolean; documents: NotebookDocument[]; total: number; formats: string[]; vector?: NotebookVectorStatus }> {
    const qs = new URLSearchParams({ limit: String(page.limit ?? 50), offset: String(page.offset ?? 0) });
    const res = await apiFetch(`/api/notebooks/${notebookId}/documents?${qs}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Notebook documents HTTP ${res.status}`);
    return res.json();
  },

  async importNotebookDocument(
    notebookId: string,
    input: ({ file: File; originKind?: 'file' | 'past_ai_output'; secretPolicy?: 'block' | 'redact' }
      | { text: string; title: string; originKind?: 'manual_text' | 'past_ai_output'; secretPolicy?: 'block' | 'redact' })
      & { retention?: NotebookRetention; retentionDuration?: string; trustLevel?: string },
  ): Promise<NotebookDocImportResult> {
    let init: RequestInit;
    if ('file' in input) {
      const form = new FormData();
      form.set('file', input.file);
      if (input.originKind) form.set('origin_kind', input.originKind);
      if (input.secretPolicy) form.set('secret_policy', input.secretPolicy);
      if (input.retention) form.set('retention', input.retention);
      if (input.retentionDuration) form.set('retention_duration', input.retentionDuration);
      if (input.trustLevel) form.set('trust_level', input.trustLevel);
      init = { method: 'POST', body: form };
    } else {
      init = {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input.text, title: input.title, origin_kind: input.originKind, secret_policy: input.secretPolicy,
          retention: input.retention, retention_duration: input.retentionDuration, trust_level: input.trustLevel,
        }),
      };
    }
    const res = await apiFetch(`/api/notebooks/${notebookId}/documents/import`, init, 120_000);
    const body = await res.json().catch(() => ({})) as NotebookDocImportResult & { error?: string; code?: string };
    if (!res.ok) {
      const err = new Error(body.error ?? `Import HTTP ${res.status}`) as Error & { code?: string };
      err.code = body.code;
      throw err;
    }
    return body;
  },

  async deleteNotebookDocument(notebookId: string, documentId: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Document delete HTTP ${res.status}`);
    return res.json();
  },

  async searchNotebookDocuments(notebookId: string, query: string, options: NotebookRetrievalOptions = {}): Promise<{ strict_local: boolean; mode: string; retrieval_mode?: 'HYBRID' | 'FTS_ONLY' | 'NONE'; vector_status: string; results: NotebookDocSearchHit[] }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/doc-search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, trust_filter: options.trustFilter, document_ids: options.documentIds, include_historical: options.includeHistorical, profile: options.profile }),
    });
    if (!res.ok) throw new Error(`Document search HTTP ${res.status}`);
    return res.json();
  },

  async askNotebookDocuments(notebookId: string, question: string, options: NotebookRetrievalOptions & { allowOutsideNotebook?: boolean } = {}): Promise<NotebookDocAnswer> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/doc-ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question, trust_filter: options.trustFilter, document_ids: options.documentIds, include_historical: options.includeHistorical,
        profile: options.profile, allow_outside_notebook: options.allowOutsideNotebook,
      }),
    }, 120_000);
    if (!res.ok) throw new Error(`Document ask HTTP ${res.status}`);
    const raw = await res.json() as Partial<NotebookDocAnswer> & { answer: string };
    // Older servers (NB-2 contract) do not send the NB-3 fields: normalise instead of assuming.
    return {
      strict_local: raw.strict_local ?? true, status: raw.status ?? 'ANSWERED', outside_notebook: raw.outside_notebook ?? false,
      answer: raw.answer, citations: raw.citations ?? [], uncertainties: raw.uncertainties ?? [], source_conflicts: raw.source_conflicts ?? [],
      sources_used: raw.sources_used ?? [], retrieval_mode: raw.retrieval_mode ?? 'NONE', mode: raw.mode ?? '',
      vector_status: raw.vector_status ?? 'NOT_USED', confidence: raw.confidence ?? 'NONE', chunks_used: raw.chunks_used ?? 0,
    };
  },

  async previewNotebookCitation(notebookId: string, chunkId: string): Promise<NotebookCitationPreview> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/citations/${encodeURIComponent(chunkId)}`, { method: 'GET' });
    if (!res.ok) throw new Error(res.status === 404 ? 'Citation introuvable (source supprimée ou expirée)' : `Citation HTTP ${res.status}`);
    return ((await res.json()) as { citation: NotebookCitationPreview }).citation;
  },

  async setNotebookDocumentTrust(notebookId: string, documentId: string, trustLevel: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/documents/${encodeURIComponent(documentId)}/trust`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trust_level: trustLevel }),
    });
    if (!res.ok) throw new Error(`Trust HTTP ${res.status}`);
    return res.json();
  },

  // Explicit user action only (never automatic): re-embed with the active model/format.
  async reindexNotebookDocuments(notebookId: string): Promise<{ ok: boolean; documents: number; reindexed: number; failed: number }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/reindex`, { method: 'POST' }, 15 * 60_000);
    const body = await res.json().catch(() => ({})) as { ok?: boolean; documents?: number; reindexed?: number; failed?: number };
    if (!res.ok && res.status !== 503) throw new Error(`Reindex HTTP ${res.status}`);
    return { ok: !!body.ok, documents: body.documents ?? 0, reindexed: body.reindexed ?? 0, failed: body.failed ?? 0 };
  },

  // ── Notebook NB-4 — imported AI histories (never sent anywhere; raw archive is not stored) ─────────────
  async aiHistoryPreview(notebookId: string, file: File, o: { declaredProvider?: AiProvider; secretPolicy?: 'block' | 'redact' } = {}): Promise<AiImportPreview> {
    const form = new FormData(); form.set('file', file);
    if (o.declaredProvider) form.set('declared_provider', o.declaredProvider);
    if (o.secretPolicy) form.set('secret_policy', o.secretPolicy);
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/preview`, { method: 'POST', body: form }, 300_000);
    const body = await res.json().catch(() => ({})) as { preview?: AiImportPreview; error?: string; code?: string; reason?: string };
    if (!res.ok || !body.preview) { const err = new Error(body.error ?? `Aperçu HTTP ${res.status}`) as Error & { code?: string }; err.code = body.code; throw err; }
    return body.preview;
  },
  async aiHistoryImport(notebookId: string, o: { previewId: string; secretPolicy: 'block' | 'redact'; retention: NotebookRetention; retentionDuration?: string; distill?: boolean }): Promise<{ importId: string }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/imports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_id: o.previewId, secret_policy: o.secretPolicy, retention: o.retention, retention_duration: o.retentionDuration, distill: o.distill }),
    }, 60_000);
    const body = await res.json().catch(() => ({})) as { importId?: string; error?: string; code?: string };
    if (!res.ok || !body.importId) { const err = new Error(body.error ?? `Import HTTP ${res.status}`) as Error & { code?: string }; err.code = body.code; throw err; }
    return { importId: body.importId };
  },
  async aiHistoryImports(notebookId: string): Promise<{ imports: AiImport[]; total: number }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/imports?limit=100`, { method: 'GET' });
    if (!res.ok) throw new Error(`Imports HTTP ${res.status}`);
    return res.json();
  },
  async aiHistoryCancel(notebookId: string, importId: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/imports/${encodeURIComponent(importId)}/cancel`, { method: 'POST' });
    return res.json();
  },
  async aiHistoryDelete(notebookId: string, importId: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/imports/${encodeURIComponent(importId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Suppression HTTP ${res.status}`);
    return res.json();
  },
  async aiHistoryDistill(notebookId: string, importId: string, useLlm = false): Promise<{ status: string; created: number; extended: number; method: string; llm: { status: string } }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/imports/${encodeURIComponent(importId)}/distill`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ use_llm: useLlm }),
    }, 300_000);
    if (!res.ok) throw new Error(`Distillation HTTP ${res.status}`);
    return res.json();
  },
  async aiHistoryConversations(notebookId: string, q: { importId?: string; provider?: AiProvider; q?: string; limit?: number; offset?: number } = {}): Promise<{ conversations: AiConversation[]; total: number }> {
    const p = new URLSearchParams({ limit: String(q.limit ?? 30), offset: String(q.offset ?? 0) });
    if (q.importId) p.set('import_id', q.importId); if (q.provider) p.set('provider', q.provider); if (q.q) p.set('q', q.q);
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/conversations?${p}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Conversations HTTP ${res.status}`);
    return res.json();
  },
  async aiHistoryMessages(notebookId: string, conversationId: string, offset = 0): Promise<{ conversation: AiConversation; messages: AiMessage[]; total: number }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/conversations/${encodeURIComponent(conversationId)}/messages?limit=100&offset=${offset}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Messages HTTP ${res.status}`);
    return res.json();
  },
  async aiHistorySearch(notebookId: string, query: string, f: AiHistoryFilters = {}): Promise<{ retrieval_mode: string; vector_status: string; results: AiHistoryHit[] }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, provider: f.provider, role: f.role, from: f.from, to: f.to, import_ids: f.importIds, conversation_ids: f.conversationIds, trust_levels: f.trustLevels, profile: f.profile }),
    });
    if (!res.ok) throw new Error(`Recherche HTTP ${res.status}`);
    return res.json();
  },
  async aiHistoryAsk(notebookId: string, question: string, f: AiHistoryFilters = {}): Promise<AiHistoryAnswer> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, provider: f.provider, role: f.role, from: f.from, to: f.to, import_ids: f.importIds, conversation_ids: f.conversationIds, trust_levels: f.trustLevels, profile: f.profile }),
    }, 120_000);
    if (!res.ok) throw new Error(`Question HTTP ${res.status}`);
    const raw = await res.json() as Partial<AiHistoryAnswer> & { answer: string; status: AiHistoryAnswer['status'] };
    return { status: raw.status, answer: raw.answer, citations: raw.citations ?? [], uncertainties: raw.uncertainties ?? [], sourceConflicts: raw.sourceConflicts ?? [], retrievalMode: raw.retrievalMode ?? 'NONE', vectorStatus: raw.vectorStatus ?? 'NOT_USED', confidence: raw.confidence ?? 'NONE', voices: raw.voices ?? [] };
  },
  async aiHistoryCitation(notebookId: string, chunkId: string): Promise<AiCitationPreview> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/citations/${encodeURIComponent(chunkId)}`, { method: 'GET' });
    if (!res.ok) throw new Error(res.status === 404 ? 'Citation introuvable (import supprimé ou expiré)' : `Citation HTTP ${res.status}`);
    return ((await res.json()) as { citation: AiCitationPreview }).citation;
  },
  async aiHistoryCandidates(notebookId: string, q: { status?: string; type?: string; limit?: number; offset?: number } = {}): Promise<{ candidates: AiCandidate[]; total: number; global_memory: boolean; types: string[] }> {
    const p = new URLSearchParams({ limit: String(q.limit ?? 50), offset: String(q.offset ?? 0) });
    if (q.status) p.set('status', q.status); if (q.type) p.set('type', q.type);
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/candidates?${p}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Candidats HTTP ${res.status}`);
    return res.json();
  },
  async aiHistoryCandidate(notebookId: string, id: string): Promise<AiCandidateDetail> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/candidates/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Candidat HTTP ${res.status}`);
    return ((await res.json()) as { candidate: AiCandidateDetail }).candidate;
  },
  // The ONLY way a candidate changes status. There is no bulk / automatic approval endpoint.
  async aiHistoryReview(notebookId: string, id: string, action: 'approve' | 'reject' | 'edit' | 'reopen', statement?: string): Promise<{ ok: boolean; candidate: AiCandidate }> {
    const res = await apiFetch(`/api/notebooks/${notebookId}/ai-history/candidates/${encodeURIComponent(id)}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, statement }),
    });
    const body = await res.json().catch(() => ({})) as { ok?: boolean; candidate?: AiCandidate; error?: string };
    if (!res.ok || !body.candidate) throw new Error(body.error ?? `Revue HTTP ${res.status}`);
    return { ok: true, candidate: body.candidate };
  },

  // ── NB-5 DOCTEUR MEMORY — approved memory. Every write below is an explicit human action; there is no bulk/auto path. ──
  memoryChatSettings: () => memoryJson<{ settings: { enabled: boolean } }>('/chat-settings'),
  setMemoryChatSettings: (enabled: boolean) => memoryJson<{ settings: { enabled: boolean } }>('/chat-settings', { method: 'PUT', body: { enabled } }),
  memoryStatus: () => memoryJson<MemoryStatusInfo>('/status'),
  memoryCreateProject: (projectId: string, name: string) => memoryJson<{ project: MemoryProject }>('/projects', { method: 'POST', body: { projectId, name } }),
  memoryNotebookProject: (notebookId: string) => memoryJson<{ notebookId: string; projectId: string | null }>(`/notebooks/${encodeURIComponent(notebookId)}/project`),
  memorySetNotebookProject: (notebookId: string, projectId: string | null) => memoryJson<{ notebookId: string; projectId: string | null }>(`/notebooks/${encodeURIComponent(notebookId)}/project`, { method: 'PUT', body: { projectId } }),
  memoryList: (q: { status?: MemoryStatus; limit?: number; offset?: number; q?: string; needsReview?: boolean } = {}) => {
    const p = new URLSearchParams({ limit: String(q.limit ?? 100), offset: String(q.offset ?? 0) });
    if (q.status) p.set('status', q.status);
    if (q.q) p.set('q', q.q);
    if (q.needsReview) p.set('needs_review', '1');
    return memoryJson<{ items: MemoryItem[]; total: number }>(`/items?${p}`);
  },
  memoryGet: (id: string) => memoryJson<{ memory: MemoryItem; evidence: MemoryEvidence[]; usageCount: number }>(`/items/${encodeURIComponent(id)}`),
  memoryRevisions: (id: string) => memoryJson<{ revisions: MemoryRevision[] }>(`/items/${encodeURIComponent(id)}/revisions`),
  memoryCreateManual: (input: MemoryWriteInput) => memoryJson<{ memory: MemoryItem; suggestions: number; conflicts: number; vector: string; warnings?: { pii: string[] } }>('/items', { method: 'POST', body: input }),
  // Approval of ONE NB-4 candidate. `approve: true` is mandatory server-side (no implicit approval).
  memoryApproveCandidate: (notebookId: string, candidateId: string, input: MemoryWriteInput) => memoryJson<{ memory: MemoryItem; suggestions: number; conflicts: number; vector: string }>(`/notebooks/${encodeURIComponent(notebookId)}/candidates/${encodeURIComponent(candidateId)}/approve`, { method: 'POST', body: { ...input, approve: true } }),
  memoryEdit: (id: string, input: MemoryWriteInput) => memoryJson<{ memory: MemoryItem; unchanged?: boolean }>(`/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
  memoryRevoke: (id: string, expectedVersion?: number, reason?: string) => memoryJson<{ memory: MemoryItem }>(`/items/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: { expectedVersion, reason } }),
  memoryArchive: (id: string, expectedVersion?: number) => memoryJson<{ memory: MemoryItem }>(`/items/${encodeURIComponent(id)}/archive`, { method: 'POST', body: { expectedVersion } }),
  memoryRestore: (id: string, expectedVersion?: number) => memoryJson<{ memory: MemoryItem }>(`/items/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { expectedVersion } }),
  memoryDelete: (id: string, expectedVersion?: number) => memoryJson<{ ok: boolean }>(`/items/${encodeURIComponent(id)}${expectedVersion != null ? `?expected_version=${expectedVersion}` : ''}`, { method: 'DELETE' }),
  memorySuggestions: () => memoryJson<{ suggestions: MemorySuggestion[] }>('/suggestions'),
  memorySupersede: (newId: string, oldId: string, expectedOldVersion?: number) => memoryJson<{ old: MemoryItem; new: MemoryItem }>('/supersede', { method: 'POST', body: { newId, oldId, confirm: true, expectedOldVersion } }),
  memoryDismissSupersede: (newId: string, oldId: string) => memoryJson<{ ok: boolean }>('/supersede/dismiss', { method: 'POST', body: { newId, oldId } }),
  memoryConflicts: () => memoryJson<{ conflicts: MemoryConflict[] }>('/conflicts'),
  memoryResolveConflict: (conflictId: string, action: 'KEEP_BOTH' | 'REVOKE_A' | 'REVOKE_B' | 'A_SUPERSEDES_B' | 'B_SUPERSEDES_A') => memoryJson<{ ok: boolean }>(`/conflicts/${encodeURIComponent(conflictId)}/resolve`, { method: 'POST', body: { action, confirm: true } }),
  memoryRetrieve: (query: string, o: { activeProject?: string | null; activeNotebook?: string | null; includeHistorical?: boolean; includeSensitive?: boolean; topK?: number } = {}) =>
    memoryJson<{ requestId: string; retrievalMode: string; vectorStatus: string; results: MemoryItem[]; conflicts: MemoryAnswer['conflicts']; notice: string | null }>('/retrieve', { method: 'POST', body: { query, ...o } }),
  memoryAnswer: (question: string, o: { activeProject?: string | null; activeNotebook?: string | null; includeHistorical?: boolean; useNotebook?: boolean } = {}) => memoryJson<MemoryAnswer>('/answer', { method: 'POST', body: { question, ...o } }, 180_000),
  memoryReindex: () => memoryJson<{ ok: boolean; reindexed: number; failed: number }>('/reindex', { method: 'POST' }, 15 * 60_000),

  // ── NotebookLM (Google) — future integration, NOT active (Phase 5B) ────────
  // Saving a key here makes ZERO calls to Google/NotebookLM — see
  // routes/notebooklm.js. Purely local storage (DPAPI) + status reporting.

  async getNotebookLmStatus(): Promise<{ key_configured: boolean; notice: string }> {
    const res = await apiFetch('/api/notebooklm/status', { method: 'GET' });
    if (!res.ok) throw new Error(`NotebookLM status HTTP ${res.status}`);
    return res.json();
  },

  async saveNotebookLmKey(key: string): Promise<{ ok: boolean; key_configured: boolean }> {
    const res = await apiFetch('/api/notebooklm/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(`NotebookLM key save HTTP ${res.status}`);
    return res.json();
  },

  async deleteNotebookLmKey(): Promise<{ ok: boolean; key_configured: boolean }> {
    const res = await apiFetch('/api/notebooklm/key', { method: 'DELETE' });
    if (!res.ok) throw new Error(`NotebookLM key delete HTTP ${res.status}`);
    return res.json();
  },

  // ── Browser selection (Phase 6) ─────────────────────────────────────────────

  async getInstalledBrowsers(): Promise<{ browsers: InstalledBrowser[] }> {
    const res = await apiFetch('/api/browser/installed', { method: 'GET' });
    if (!res.ok) throw new Error(`Installed browsers HTTP ${res.status}`);
    return res.json();
  },

  async getBrowserSettings(): Promise<BrowserSettings> {
    const res = await apiFetch('/api/browser/settings', { method: 'GET' });
    if (!res.ok) throw new Error(`Browser settings HTTP ${res.status}`);
    return res.json();
  },

  async updateBrowserSettings(selected: string, customPath?: string): Promise<BrowserSettings> {
    const res = await apiFetch('/api/browser/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selected, customPath }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Browser settings update HTTP ${res.status}`);
    return body;
  },

  async openInBrowser(url: string): Promise<{ opened: boolean; url: string }> {
    const res = await apiFetch('/api/browser/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Browser open HTTP ${res.status}`);
    return body;
  },

  // ── Sherlock OSINT (Phase 7) ─────────────────────────────────────────────────

  async getSherlockStatus(): Promise<SherlockInstallState> {
    const res = await apiFetch('/api/sherlock/status', { method: 'GET' });
    if (!res.ok) throw new Error(`Sherlock status HTTP ${res.status}`);
    return res.json();
  },

  async testSherlockInstall(): Promise<{ ok: boolean; installed: boolean; version?: string }> {
    const res = await apiFetch('/api/sherlock/test', { method: 'POST' }, 15_000);
    return res.json();
  },

  async installSherlock(): Promise<{ jobId: string }> {
    const res = await apiFetch('/api/sherlock/install', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Sherlock install HTTP ${res.status}`);
    return body;
  },

  async uninstallSherlock(): Promise<{ jobId: string }> {
    const res = await apiFetch('/api/sherlock/uninstall', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Sherlock uninstall HTTP ${res.status}`);
    return body;
  },

  async searchSherlock(username: string, options?: { timeoutMs?: number }): Promise<{ jobId: string; username: string }> {
    const res = await apiFetch('/api/sherlock/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Sherlock search HTTP ${res.status}`);
    return body;
  },

  async cancelSherlockSearch(jobId: string): Promise<{ cancelled: boolean }> {
    const res = await apiFetch(`/api/sherlock/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error('Sherlock cancellation failed');
    return res.json();
  },

  async getSherlockJob(jobId: string): Promise<SherlockJob> {
    const res = await apiFetch(`/api/sherlock/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Sherlock job HTTP ${res.status}`);
    return res.json();
  },

  async saveSherlockResultAsNeuron(username: string, site: string, url: string): Promise<{ id: string }> {
    const res = await apiFetch('/api/sherlock/save-as-neuron', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, site, url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Sherlock save HTTP ${res.status}`);
    return body;
  },

  // ── Voice ──────────────────────────────────────────────────────────────────

  async getVoiceSettings(): Promise<VoiceSettings> {
    const res = await apiFetch('/api/voice/settings', { method: 'GET' });
    if (!res.ok) throw new Error(`Voice settings HTTP ${res.status}`);
    return res.json() as Promise<VoiceSettings>;
  },

  async updateVoiceSettings(updates: Partial<VoiceSettings>): Promise<void> {
    const res = await apiFetch('/api/voice/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`Voice settings update HTTP ${res.status}`);
  },

  async uploadPorcupineModel(file: File): Promise<void> {
    const fd = new FormData();
    fd.append('model', file);
    const res = await apiFetch('/api/voice/porcupine-model', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Porcupine model upload HTTP ${res.status}`);
  },

  async getPorcupineModel(): Promise<{ model_base64: string }> {
    const res = await apiFetch('/api/voice/porcupine-model', { method: 'GET' });
    if (!res.ok) throw new Error(`Porcupine model HTTP ${res.status}`);
    return res.json() as Promise<{ model_base64: string }>;
  },

  async resummarise(
    params:     { transcription: string; level: ResummariseLevel; focus?: string; use_powerful?: boolean; style_example_type?: string },
    onProgress: (p: ResummariseProgress) => void,
    signal?:    AbortSignal,
  ): Promise<{ summary: string; model_used: string; used_examples?: StyleExampleUsed[] }> {
    const res = await fetch(`${BASE}/api/capture/resummarise`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Resummarise HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Stream terminé sans résultat');
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/^data:\s*/, '').trim();
        if (!line) continue;
        let evt: ResummariseProgress;
        try { evt = JSON.parse(line) as ResummariseProgress; } catch { continue; }
        if (evt.error) throw new Error(evt.error);
        if (evt.done && evt.result) return evt.result;
        onProgress(evt);
      }
    }
  },

  async repairLinks(): Promise<{ channelLinksRepaired: number; playlistLinksRepaired: number }> {
    const res = await apiFetch('/api/neurons/repair-links', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Repair links HTTP ${res.status}`);
    }
    return res.json() as Promise<{ channelLinksRepaired: number; playlistLinksRepaired: number }>;
  },

  // ── Multi-model comparison ────────────────────────────────────────────────────

  async compareModels(
    params:   { question: string; models: string[]; max_context?: number },
    onEvent:  (e: CompareEvent) => void,
    signal?:  AbortSignal,
  ): Promise<void> {
    const res = await apiFetch('/api/compare', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
      signal,
    }, 300_000); // up to 5 min for several local models
    if (!res.ok) throw new Error(`Compare HTTP ${res.status}`);

    const reader  = res.body!.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/^data:\s*/, '').trim();
        if (!line) continue;
        let evt: CompareEvent;
        try { evt = JSON.parse(line) as CompareEvent; } catch { continue; }
        onEvent(evt);
        if (evt.type === 'done') return;
      }
    }
  },

  // ── Web quick answer (local LLM + DuckDuckGo, never cloud) ──────────────────

  async webAnswer(
    question: string,
    onEvent:  (evt: WebAnswerEvent) => void,
    signal?:  AbortSignal,
  ): Promise<void> {
    const res = await apiFetch('/api/web-answer', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question }),
      signal,
    }, 120_000);
    if (!res.ok || !res.body) throw new Error(`Web answer HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/^data:\s*/, '').trim();
        if (!line) continue;
        let evt: WebAnswerEvent;
        try { evt = JSON.parse(line) as WebAnswerEvent; } catch { continue; }
        onEvent(evt);
        if (evt.type === 'done') return;
      }
    }
  },

  // ── Web explore — Mode A (raw results, no AI) ────────────────────────────────

  async webResults(query: string, maxResults = 20): Promise<{ results: WebSearchResult[]; count: number }> {
    const res = await apiFetch('/api/web-results', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query, max_results: maxResults }),
    }, 30_000);
    if (!res.ok) throw new Error(`Web results HTTP ${res.status}`);
    return res.json() as Promise<{ results: WebSearchResult[]; count: number }>;
  },

  // ── Web explore — Mode B (deep exploration, local AI) ────────────────────────

  async webDeep(
    question: string,
    maxPages: number,
    cancelToken: string,
    onEvent: (evt: WebDeepEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await apiFetch('/api/web-deep', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, max_pages: maxPages, cancel_token: cancelToken }),
      signal,
    }, 300_000);
    if (!res.ok || !res.body) throw new Error(`Web deep HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/^data:\s*/, '').trim();
        if (!line) continue;
        let evt: WebDeepEvent;
        try { evt = JSON.parse(line) as WebDeepEvent; } catch { continue; }
        onEvent(evt);
        if (evt.type === 'done') return;
      }
    }
  },

  async cancelWebDeep(token: string): Promise<void> {
    try {
      await apiFetch('/api/web-deep/cancel', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token }),
      }, 5_000);
    } catch { /* ignore — best-effort cancel */ }
  },

  // ── Compétences (skills) ──────────────────────────────────────────────────

  async listSkills(): Promise<SkillsListResult> {
    const res = await apiFetch('/api/skills', { method: 'GET' });
    return await res.json() as SkillsListResult;
  },

  async createSkill(data: Partial<Omit<Skill, 'id' | 'version' | 'instruction_history' | 'run_count' | 'last_run_at' | 'created_at' | 'updated_at'>>): Promise<Skill> {
    const res = await apiFetch('/api/skills', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const d = await res.json() as { skill: Skill };
    return d.skill;
  },

  async updateSkill(id: string, data: Partial<Skill>): Promise<Skill> {
    const res = await apiFetch(`/api/skills/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const d = await res.json() as { skill: Skill };
    return d.skill;
  },

  async deleteSkill(id: string): Promise<void> {
    await apiFetch(`/api/skills/${id}`, { method: 'DELETE' });
  },

  async generateSkillInstruction(description: string, example?: string): Promise<SkillGenerateResult> {
    const res = await apiFetch('/api/skills/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ description, example }),
    }, 60_000);
    return await res.json() as SkillGenerateResult;
  },

  async refineSkillInstruction(id: string, feedback: string, badOutput?: string): Promise<{ instruction: string; model_used: string }> {
    const res = await apiFetch(`/api/skills/${id}/refine`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ feedback, bad_output: badOutput }),
    }, 60_000);
    return await res.json() as { instruction: string; model_used: string };
  },

  async runSkill(id: string, input: string): Promise<SkillRunResult> {
    const res = await apiFetch(`/api/skills/${id}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ input }),
    }, 120_000);
    return await res.json() as SkillRunResult;
  },

  async getSkillRuns(id: string, limit = 30): Promise<SkillRun[]> {
    const res = await apiFetch(`/api/skills/${id}/runs?limit=${limit}`, { method: 'GET' });
    const d   = await res.json() as { runs: SkillRun[] };
    return d.runs;
  },

  async importSkill(data: Record<string, unknown>): Promise<Skill> {
    const res = await apiFetch('/api/skills/import', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const d = await res.json() as { skill: Skill };
    return d.skill;
  },

  getSkillExportUrl(id: string): string {
    return `${BASE}/api/skills/export/${id}`;
  },

  // ── Générateur de prompts ────────────────────────────────────────────────

  async getPromptGeneratorModels(): Promise<PromptGeneratorModelsResult> {
    const res = await apiFetch('/api/prompt-generator/models', { method: 'GET' });
    return await res.json() as PromptGeneratorModelsResult;
  },

  async getPromptGeneratorSettings(): Promise<PromptGeneratorSettings> {
    const res = await apiFetch('/api/prompt-generator/settings', { method: 'GET' });
    return await res.json() as PromptGeneratorSettings;
  },

  async setPromptGeneratorSettings(data: Partial<PromptGeneratorSettings>): Promise<PromptGeneratorSettings> {
    const res = await apiFetch('/api/prompt-generator/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    return await res.json() as PromptGeneratorSettings;
  },

  async listGeneratedPrompts(filters?: { from?: string; to?: string; model?: string; outcome?: string; q?: string; templatesOnly?: boolean }): Promise<{ prompts: GeneratedPrompt[]; count: number }> {
    const params = new URLSearchParams();
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    if (filters?.model) params.set('model', filters.model);
    if (filters?.outcome) params.set('outcome', filters.outcome);
    if (filters?.q) params.set('q', filters.q);
    if (filters?.templatesOnly) params.set('templates', '1');
    const qs  = params.toString();
    const res = await apiFetch(`/api/prompt-generator${qs ? `?${qs}` : ''}`, { method: 'GET' });
    return await res.json() as { prompts: GeneratedPrompt[]; count: number };
  },

  async generatePrompt(data: { request: string; draft_model: string; draft_provider: string; review_model: string; review_provider: string }): Promise<GeneratedPrompt> {
    const res = await apiFetch('/api/prompt-generator/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    }, 120_000);
    const d = await res.json() as { prompt: GeneratedPrompt };
    return d.prompt;
  },

  async regeneratePrompt(id: string, data?: { draft_model?: string; draft_provider?: string; review_model?: string; review_provider?: string }): Promise<GeneratedPrompt> {
    const res = await apiFetch(`/api/prompt-generator/${id}/regenerate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data ?? {}),
    }, 120_000);
    const d = await res.json() as { prompt: GeneratedPrompt };
    return d.prompt;
  },

  async updateGeneratedPrompt(id: string, data: Partial<Pick<GeneratedPrompt, 'kept_version' | 'outcome' | 'is_template'>>): Promise<GeneratedPrompt> {
    const res = await apiFetch(`/api/prompt-generator/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const d = await res.json() as { prompt: GeneratedPrompt };
    return d.prompt;
  },

  async deleteGeneratedPrompt(id: string): Promise<void> {
    await apiFetch(`/api/prompt-generator/${id}`, { method: 'DELETE' });
  },

  async importGeneratedPrompts(data: Record<string, unknown>): Promise<{ ok: boolean; imported: number; total: number }> {
    const res = await apiFetch('/api/prompt-generator/import', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    return await res.json() as { ok: boolean; imported: number; total: number };
  },

  getPromptGeneratorExportUrl(): string {
    return `${BASE}/api/prompt-generator/export/all`;
  },

  async getPromptDestinations(): Promise<PromptDestination[]> {
    const res = await apiFetch('/api/prompt-generator/destinations', { method: 'GET' });
    const d = await res.json() as { destinations: PromptDestination[] };
    return d.destinations;
  },

  async addPromptDestination(data: Omit<PromptDestination, 'id' | 'order'>): Promise<PromptDestination[]> {
    const res = await apiFetch('/api/prompt-generator/destinations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Add destination HTTP ${res.status}`);
    }
    const d = await res.json() as { destinations: PromptDestination[] };
    return d.destinations;
  },

  async updatePromptDestination(id: string, data: Partial<Omit<PromptDestination, 'id' | 'order'>>): Promise<PromptDestination[]> {
    const res = await apiFetch(`/api/prompt-generator/destinations/${encodeURIComponent(id)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Update destination HTTP ${res.status}`);
    }
    const d = await res.json() as { destinations: PromptDestination[] };
    return d.destinations;
  },

  async deletePromptDestination(id: string): Promise<PromptDestination[]> {
    const res = await apiFetch(`/api/prompt-generator/destinations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete destination HTTP ${res.status}`);
    const d = await res.json() as { destinations: PromptDestination[] };
    return d.destinations;
  },

  async reorderPromptDestinations(ids: string[]): Promise<PromptDestination[]> {
    const res = await apiFetch('/api/prompt-generator/destinations/reorder', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`Reorder destinations HTTP ${res.status}`);
    const d = await res.json() as { destinations: PromptDestination[] };
    return d.destinations;
  },

  // ── Bibliothèque de modèles ("Modèles") ─────────────────────────────────────
  // Purely local CRUD + a bookkeeping "touch" — none of these ever call an AI
  // provider. Loading a template into the editor is the frontend's job
  // (copies prompt_text into the request textarea); this client only fetches
  // the text.

  async getPromptTemplates(): Promise<PromptTemplate[]> {
    const res = await apiFetch('/api/prompt-generator/templates', { method: 'GET' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Prompt templates list HTTP ${res.status}`);
    }
    const d = await res.json() as { templates: PromptTemplate[] };
    return d.templates;
  },

  async createPromptTemplate(data: { name: string; category?: string; description?: string; prompt_text: string }): Promise<PromptTemplate> {
    const res = await apiFetch('/api/prompt-generator/templates', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Prompt template create HTTP ${res.status}`);
    }
    const d = await res.json() as { template: PromptTemplate };
    return d.template;
  },

  async updatePromptTemplate(id: string, updates: Partial<Pick<PromptTemplate, 'name' | 'category' | 'description' | 'prompt_text'>>): Promise<PromptTemplate> {
    const res = await apiFetch(`/api/prompt-generator/templates/${encodeURIComponent(id)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Prompt template update HTTP ${res.status}`);
    }
    const d = await res.json() as { template: PromptTemplate };
    return d.template;
  },

  async deletePromptTemplate(id: string): Promise<void> {
    const res = await apiFetch(`/api/prompt-generator/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Prompt template delete HTTP ${res.status}`);
    }
  },

  async reorderPromptTemplates(orderedIds: string[]): Promise<PromptTemplate[]> {
    const res = await apiFetch('/api/prompt-generator/templates/reorder', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ordered_ids: orderedIds }),
    });
    if (!res.ok) throw new Error(`Reorder prompt templates HTTP ${res.status}`);
    const d = await res.json() as { templates: PromptTemplate[] };
    return d.templates;
  },

  async touchPromptTemplate(id: string): Promise<PromptTemplate> {
    const res = await apiFetch(`/api/prompt-generator/templates/${encodeURIComponent(id)}/touch`, { method: 'POST' });
    if (!res.ok) throw new Error(`Touch prompt template HTTP ${res.status}`);
    const d = await res.json() as { template: PromptTemplate };
    return d.template;
  },

  async sendGeneratedPrompt(id: string, data: { destinationId: string; prefillUsed: boolean }): Promise<{ event: PromptSendEvent; events: PromptSendEvent[] }> {
    const res = await apiFetch(`/api/prompt-generator/${id}/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `Send prompt HTTP ${res.status}`);
    }
    return await res.json() as { event: PromptSendEvent; events: PromptSendEvent[] };
  },

  async getPromptSendEvents(id: string): Promise<PromptSendEvent[]> {
    const res = await apiFetch(`/api/prompt-generator/${id}/send-events`, { method: 'GET' });
    if (!res.ok) throw new Error(`Send events HTTP ${res.status}`);
    const d = await res.json() as { events: PromptSendEvent[] };
    return d.events;
  },

  // ── Job tracking (survives Console close; enables TopBar indicator + reload) ─

  async getJobs(): Promise<ServerJob[]> {
    try {
      const res = await fetchTimeout(`${BASE}/api/jobs`, { method: 'GET' }, 5_000);
      if (!res.ok) return [];
      const data = await res.json() as { jobs: ServerJob[] };
      return data.jobs ?? [];
    } catch {
      return [];
    }
  },

  async startJob(operation: string, total: number): Promise<string> {
    try {
      const res = await apiFetch('/api/jobs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ operation, total }),
      }, 5_000);
      if (!res.ok) return '';
      const data = await res.json() as { id: string };
      return data.id ?? '';
    } catch {
      return '';
    }
  },

  // Returns false when the server no longer knows this job id (JOB_NOT_FOUND
  // — routine after a cortex-server restart, since job tracking is
  // intentionally in-memory only) so the caller can stop re-sending updates
  // for a dead id instead of silently retrying it every debounce tick for
  // the rest of a long-running local batch.
  async updateJob(id: string, update: Partial<Pick<ServerJob, 'current' | 'currentLabel' | 'okCount' | 'fallbackCount' | 'errorCount'>>): Promise<boolean> {
    if (!id) return false;
    try {
      const res = await apiFetch(`/api/jobs/${encodeURIComponent(id)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(update),
      }, 5_000);
      return res.ok;
    } catch {
      // Network-level failure (e.g. server mid-restart) — not a confirmed
      // "job gone", so don't tell the caller to stop; let it retry next tick.
      return true;
    }
  },

  async finishJob(id: string, summary: string, status: 'done' | 'error' = 'done'): Promise<void> {
    if (!id) return;
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(id)}`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status, summary }),
      }, 5_000);
    } catch { /* non-critical, ignore */ }
  },

  // ── Todo items ────────────────────────────────────────────────────────────────

  async getTodos(): Promise<TodoItem[]> {
    try {
      const res = await apiFetch('/api/todo', { method: 'GET' });
      if (!res.ok) return [];
      const data = await res.json() as { items: TodoItem[] };
      return data.items ?? [];
    } catch {
      return [];
    }
  },

  async addTodo(item: Omit<TodoItem, 'status' | 'created_at' | 'done_at' | 'result_page_id' | 'error'>): Promise<void> {
    const res = await apiFetch('/api/todo', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(item),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Todo HTTP ${res.status}`);
    }
  },

  async updateTodo(id: string, updates: Partial<Pick<TodoItem, 'status' | 'title' | 'note' | 'result_page_id' | 'error' | 'done_at' | 'priority'>>): Promise<void> {
    const res = await apiFetch(`/api/todo/${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`UpdateTodo HTTP ${res.status}`);
  },

  async deleteTodo(id: string): Promise<void> {
    const res = await apiFetch(`/api/todo/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DeleteTodo HTTP ${res.status}`);
  },

  // ── Kiwix (bibliothèque d'archives ZIM) ────────────────────────────────────

  async kiwixSettings(): Promise<KiwixSettings> {
    const res = await apiFetch('/api/kiwix/settings', { method: 'GET' }, 8_000);
    return await res.json() as KiwixSettings;
  },

  async setKiwixSettings(updates: Partial<Pick<KiwixSettings, 'kiwixServePath' | 'archivesFolder' | 'port' | 'autoDetect'>>): Promise<KiwixSettings> {
    const res = await apiFetch('/api/kiwix/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
    }, 8_000);
    const d = await res.json() as { settings: KiwixSettings };
    return d.settings;
  },

  async kiwixSearchScope(): Promise<KiwixSearchScope> {
    const res = await apiFetch('/api/kiwix/search-scope', { method: 'GET' }, 8_000);
    const d = await res.json() as { scope: KiwixSearchScope };
    return d.scope;
  },

  async setKiwixSearchScope(scope: KiwixSearchScope): Promise<void> {
    await apiFetch('/api/kiwix/search-scope', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }),
    }, 8_000);
  },

  async kiwixArchives(): Promise<KiwixArchivesResult> {
    const res = await apiFetch('/api/kiwix/archives', { method: 'GET' }, 8_000);
    return await res.json() as KiwixArchivesResult;
  },

  async deleteKiwixArchive(fileName: string): Promise<void> {
    const res = await apiFetch(`/api/kiwix/archives/${encodeURIComponent(fileName)}`, { method: 'DELETE' }, 8_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `DeleteArchive HTTP ${res.status}`);
    }
  },

  async kiwixStatus(): Promise<KiwixStatus> {
    const res = await apiFetch('/api/kiwix/status', { method: 'GET' }, 8_000);
    return await res.json() as KiwixStatus;
  },

  async startKiwix(): Promise<KiwixStartResult> {
    const res = await apiFetch('/api/kiwix/start', { method: 'POST' }, 20_000);
    return await res.json() as KiwixStartResult;
  },

  async stopKiwix(): Promise<{ ok: boolean }> {
    const res = await apiFetch('/api/kiwix/stop', { method: 'POST' }, 8_000);
    return await res.json() as { ok: boolean };
  },

  async kiwixSuggest(book: string, term: string): Promise<KiwixSuggestion[]> {
    const q = new URLSearchParams({ book, term });
    const res = await apiFetch(`/api/kiwix/suggest?${q.toString()}`, { method: 'GET' }, 8_000);
    const d = await res.json() as { suggestions: KiwixSuggestion[] };
    return d.suggestions ?? [];
  },

  async kiwixSearchArchives(book: string, pattern: string): Promise<KiwixSearchResult[]> {
    const q = new URLSearchParams({ book, pattern });
    const res = await apiFetch(`/api/kiwix/search?${q.toString()}`, { method: 'GET' }, 15_000);
    const d = await res.json() as { results: KiwixSearchResult[] };
    return d.results ?? [];
  },

  async kiwixArticle(book: string, articlePath: string): Promise<KiwixArticleContent> {
    const cleanPath = articlePath.replace(/^\/+/, '');
    const res = await apiFetch(`/api/kiwix/content/${encodeURIComponent(book)}/${cleanPath}`, { method: 'GET' }, 15_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `KiwixArticle HTTP ${res.status}`);
    }
    return await res.json() as KiwixArticleContent;
  },

  kiwixRawAssetUrl(book: string, assetPath: string): string {
    const cleanPath = assetPath.replace(/^\/+/, '');
    return `${BASE}/api/kiwix/raw/${encodeURIComponent(book)}/${cleanPath}`;
  },

  async kiwixCatalog(q: string, lang?: string): Promise<KiwixCatalogEntry[]> {
    const params = new URLSearchParams({ q });
    if (lang) params.set('lang', lang);
    const res = await apiFetch(`/api/kiwix/catalog?${params.toString()}`, { method: 'GET' }, 20_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `KiwixCatalog HTTP ${res.status}`);
    }
    const d = await res.json() as { entries: KiwixCatalogEntry[] };
    return d.entries ?? [];
  },

  async kiwixDiskSpace(): Promise<number | null> {
    const res = await apiFetch('/api/kiwix/disk-space', { method: 'GET' }, 8_000);
    const d = await res.json() as { freeBytes: number | null };
    return d.freeBytes;
  },

  async downloadKiwixArchive(
    entry: { url: string; fileName: string; sizeBytes: number },
    onProgress: (p: KiwixDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${BASE}/api/kiwix/download`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(entry),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Download HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('Réponse sans flux');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/^data:\s*/, '').trim();
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as KiwixDownloadProgress;
          if (evt.type === 'error') throw new Error(evt.message ?? 'Erreur de téléchargement');
          onProgress(evt);
        } catch (e) {
          if (e instanceof Error && e.message !== 'Unexpected end of JSON input') throw e;
        }
      }
    }
  },

  async importKiwixArticle(data: { book: string; path: string; title: string; text?: string }): Promise<{ ok: boolean; neuronIds: string[]; chunkCount: number }> {
    const res = await apiFetch('/api/kiwix/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `ImportKiwix HTTP ${res.status}`);
    }
    return await res.json() as { ok: boolean; neuronIds: string[]; chunkCount: number };
  },

  // ── Lecteur audio (lo-fi ambiant) ────────────────────────────────────────────

  async getAudioPlayerSettings(): Promise<AudioPlayerSettings> {
    const res = await apiFetch('/api/audio-player/settings', { method: 'GET' }, 10_000);
    if (!res.ok) throw new Error(`Audio player settings HTTP ${res.status}`);
    return res.json() as Promise<AudioPlayerSettings>;
  },

  async setAudioPlayerSettings(updates: Partial<Omit<AudioPlayerSettings, 'presets'>>): Promise<{ ok: boolean; settings: AudioPlayerSettings }> {
    const res = await apiFetch('/api/audio-player/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    }, 10_000);
    if (!res.ok) throw new Error(`Set audio player settings HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean; settings: AudioPlayerSettings }>;
  },

  async getAudioLocalFiles(): Promise<AudioLocalFilesResult> {
    const res = await apiFetch('/api/audio-player/local-files', { method: 'GET' }, 10_000);
    return res.json() as Promise<AudioLocalFilesResult>;
  },

  getAudioFileUrl(filePath: string): string {
    return `${BASE}/api/audio-player/file?path=${encodeURIComponent(filePath)}`;
  },

  // ── Module Professeur ──────────────────────────────────────────────────

  async getTeacherSettings(): Promise<TeacherSettings> {
    const res = await apiFetch('/api/teacher/settings', { method: 'GET' });
    return await res.json() as TeacherSettings;
  },

  async setTeacherSettings(data: Partial<TeacherSettings>): Promise<TeacherSettings> {
    const res = await apiFetch('/api/teacher/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    return await res.json() as TeacherSettings;
  },

  async getTeacherQuota(): Promise<TeacherQuotaInfo> {
    const res = await apiFetch('/api/teacher/quota', { method: 'GET' });
    return await res.json() as TeacherQuotaInfo;
  },

  async getTeacherAvailableModels(): Promise<TeacherAvailableModels> {
    const res = await apiFetch('/api/teacher/available-models', { method: 'GET' }, 15_000);
    if (!res.ok) throw new Error(`Available models HTTP ${res.status}`);
    return await res.json() as TeacherAvailableModels;
  },

  async validateTeacherModel(model: string): Promise<TeacherValidateModelResult> {
    const res = await apiFetch('/api/teacher/settings/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    }, 30_000);
    return await res.json() as TeacherValidateModelResult;
  },

  async getTeacherRegisters(): Promise<{ registers: { id: TeacherRegister; label: string }[] }> {
    const res = await apiFetch('/api/teacher/registers', { method: 'GET' });
    return await res.json() as { registers: { id: TeacherRegister; label: string }[] };
  },

  async listLearningPaths(status?: LearningPathStatus): Promise<{ paths: LearningPath[] }> {
    const qs = status ? `?status=${status}` : '';
    const res = await apiFetch(`/api/teacher/paths${qs}`, { method: 'GET' });
    return await res.json() as { paths: LearningPath[] };
  },

  async getLearningPath(id: string): Promise<{ path: LearningPath; steps: LearningPathStep[] }> {
    const res = await apiFetch(`/api/teacher/paths/${id}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Parcours introuvable (HTTP ${res.status})`);
    return await res.json() as { path: LearningPath; steps: LearningPathStep[] };
  },

  async createLearningPath(subject: string, register: TeacherRegister): Promise<{ path: LearningPath; model_used: string; forced_local: boolean }> {
    const res = await apiFetch('/api/teacher/paths', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, register }),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Création du parcours HTTP ${res.status}`);
    }
    return await res.json() as { path: LearningPath; model_used: string; forced_local: boolean };
  },

  async updateLearningPathPlan(id: string, plan: LearningPlanStep[]): Promise<{ path: LearningPath }> {
    const res = await apiFetch(`/api/teacher/paths/${id}/plan`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Mise à jour du plan HTTP ${res.status}`);
    }
    return await res.json() as { path: LearningPath };
  },

  async startLearningPath(id: string): Promise<{ path: LearningPath; steps: LearningPathStep[] }> {
    const res = await apiFetch(`/api/teacher/paths/${id}/start`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Démarrage HTTP ${res.status}`);
    }
    return await res.json() as { path: LearningPath; steps: LearningPathStep[] };
  },

  async abandonLearningPath(id: string): Promise<{ path: LearningPath }> {
    const res = await apiFetch(`/api/teacher/paths/${id}/abandon`, { method: 'POST' });
    return await res.json() as { path: LearningPath };
  },

  async deleteLearningPath(id: string): Promise<void> {
    await apiFetch(`/api/teacher/paths/${id}`, { method: 'DELETE' });
  },

  async explainStep(pathId: string, stepId: string): Promise<{ step: LearningPathStep; model_used: string; forced_local: boolean; requested_provider?: string | null; fallback_reason_code?: TeacherFallbackReasonCode | null; fallback_reason?: string | null; sources_used?: { id: string; title: string }[] }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/explain`, { method: 'POST' }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string; quota_hit?: boolean };
      throw new Error(err.error ?? `Explication HTTP ${res.status}`);
    }
    return await res.json() as { step: LearningPathStep; model_used: string; forced_local: boolean; sources_used?: { id: string; title: string }[] };
  },

  async answerStepQuestion(pathId: string, stepId: string, answer: string): Promise<{ step: LearningPathStep; evaluation: string; validated: boolean; model_used: string; forced_local: boolean }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Évaluation HTTP ${res.status}`);
    }
    return await res.json() as { step: LearningPathStep; evaluation: string; validated: boolean; model_used: string; forced_local: boolean };
  },

  async advanceStep(pathId: string, stepId: string): Promise<{ path: LearningPath; steps: LearningPathStep[]; finished: boolean }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/advance`, { method: 'POST' });
    return await res.json() as { path: LearningPath; steps: LearningPathStep[]; finished: boolean };
  },

  async backStep(pathId: string, stepId: string): Promise<{ path: LearningPath; steps: LearningPathStep[] }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/back`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Retour HTTP ${res.status}`);
    }
    return await res.json() as { path: LearningPath; steps: LearningPathStep[] };
  },

  async createRecapNeuron(pathId: string): Promise<{ path: LearningPath; neuron_id: string; review_items_created: number }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/recap`, { method: 'POST' }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Création de la fiche HTTP ${res.status}`);
    }
    return await res.json() as { path: LearningPath; neuron_id: string; review_items_created: number };
  },

  async getDueReviewItems(limit = 5): Promise<{ items: ReviewItem[]; count_due: number }> {
    const res = await apiFetch(`/api/teacher/review/due?limit=${limit}`, { method: 'GET' });
    return await res.json() as { items: ReviewItem[]; count_due: number };
  },

  async answerReviewItem(itemId: string, answer: string): Promise<{ correct: boolean; feedback: string; next_review_at: string; interval_days: number; item: ReviewItem }> {
    const res = await apiFetch(`/api/teacher/review/${itemId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }),
    }, 60_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Évaluation HTTP ${res.status}`);
    }
    return await res.json() as { correct: boolean; feedback: string; next_review_at: string; interval_days: number; item: ReviewItem };
  },

  async getTeacherStats(): Promise<TeacherStats> {
    const res = await apiFetch('/api/teacher/stats', { method: 'GET' });
    return await res.json() as TeacherStats;
  },

  // ── [Professeur V2 — PROF-2] dual-track endpoints (the UI arrives in PROF-3) ──────────────────────────────────
  async createDualTrackLearningPath(subject: string, register: TeacherRegister): Promise<{ path: DualTrackLearningPath; model_used: string; forced_local: boolean }> {
    const res = await apiFetch('/api/teacher/paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, register, schema_version: 2 }),
    }, 60_000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },

  async submitTheoryAnswer(pathId: string, stepId: string, answer: string): Promise<TeacherEvaluationResult> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/theory/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }),
    }, 60_000);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code });
    return data;
  },

  async submitPractice(pathId: string, stepId: string, submission: { mode: 'self_report'; confirmations: boolean[]; note?: string } | { mode: 'deliverable'; submission: string }): Promise<TeacherEvaluationResult> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/practice/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission),
    }, 60_000);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code });
    return data;
  },

  async getTrackAttempts(pathId: string, stepId: string, track?: TeacherTrackName): Promise<{ attempts: TeacherTrackAttempt[] }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/attempts${track ? `?track=${track}` : ''}`, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },
  // ── [/Professeur V2 — PROF-2] ─────────────────────────────────────────────────────────────────────────────────

  // ── [Professeur V2 — PROF-3] exercice pratique généré + avance contrôlée (erreurs du verrou serveur remontées) ──
  async generatePracticeSpec(pathId: string, stepId: string): Promise<TeacherPracticeSpecResult> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/practice/spec`, { method: 'POST' }, 60_000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code });
    return data;
  },

  async advanceDualTrackStep(pathId: string, stepId: string): Promise<TeacherDualTrackAdvanceResult> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/advance`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code });
    return data;
  },
  // ── [/Professeur V2 — PROF-3] ─────────────────────────────────────────────────────────────────────────────────

  // ── [Professeur V2 — PROF-4] historique des tentatives (lecture seule) ────────────────────────────────────────
  async getTrackHistory(pathId: string, stepId: string): Promise<{ attempts: TeacherAttemptView[] }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/attempts`, { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code });
    return data;
  },
  // ── [/Professeur V2 — PROF-4] ─────────────────────────────────────────────────────────────────────────────────

  // ── [Professeur V2 — PROF-5] Sport Coach ──────────────────────────────────────────────────────────────────────
  async getSportOptions(): Promise<SportOptions> {
    const res = await apiFetch('/api/teacher/sport/options', { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },

  async createSportPath(register: TeacherRegister, profile: SportProfileInput): Promise<{ path: DualTrackLearningPath; program_source: 'model' | 'catalog'; fallback_reason: string | null }> {
    const res = await apiFetch('/api/teacher/sport/paths', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ register, profile }),
    }, 90_000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code, errors: data.errors }) as SportCreateError;
    return data;
  },
  // ── [/Professeur V2 — PROF-5] ─────────────────────────────────────────────────────────────────────────────────

  // ── [Professeur V2 — PROF-6] séance déclarée + check-in, reprise après pause ──────────────────────────────────
  async submitWorkout(pathId: string, stepId: string, body: { confirmations: boolean[]; note?: string; checkin: Omit<SportCheckin, 'comment' | 'pain_worsening' | 'unavailable_equipment' | 'pain_areas'> & Partial<SportCheckin> }): Promise<TeacherEvaluationResult & { sport?: SportLoopResult }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/steps/${stepId}/practice/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'self_report', ...body }),
    }, 60_000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code, errors: data.errors }) as SportCreateError;
    return data;
  },

  async resumeSport(pathId: string): Promise<{ path: DualTrackLearningPath; steps: DualTrackLearningStep[]; sport: { adaptation: SportAdaptation | null; pause: null } }> {
    const res = await apiFetch(`/api/teacher/paths/${pathId}/sport/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ no_pain: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code });
    return data;
  },
  // ── [/Professeur V2 — PROF-6] ─────────────────────────────────────────────────────────────────────────────────

  // ── [Agency V1] orchestration d'agents ────────────────────────────────────────────────────────────────────────
  agencyListRuns(): Promise<{ runs: AgencyRun[] }> { return agencyCall('/api/agency/runs'); },
  agencyGetRun(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/runs/${encodeURIComponent(id)}`); },
  agencyCreateRun(body: { objective: string; strictLocal: boolean; maxConcurrency: number; saveResult: boolean; autoStart?: boolean }): Promise<AgencySnapshot> {
    return agencyCall('/api/agency/runs', { method: 'POST', body: JSON.stringify(body) });
  },
  agencyStartRun(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/runs/${encodeURIComponent(id)}/start`, { method: 'POST' }); },
  agencyResumeRun(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }); },
  agencyCancelRun(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); },
  agencyStopRun(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' }); },
  agencyStopAll(): Promise<{ stopped: number }> { return agencyCall('/api/agency/stop-all', { method: 'POST' }); },
  agencyRetryTask(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' }); },
  agencyCancelTask(id: string): Promise<AgencySnapshot> { return agencyCall(`/api/agency/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); },
  agencyDecideApproval(id: string, accepted: boolean, digest: string): Promise<AgencySnapshot> {
    return agencyCall(`/api/agency/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ accepted, digest }) });
  },
  // ── [/Agency V1] ──────────────────────────────────────────────────────────────────────────────────────────────

  // ── [Model Router V1] ─────────────────────────────────────────────────────────────────────────────────────────
  modelRouterRegistry(): Promise<ModelRouterRegistry> { return modelRouterCall('/api/model-router/registry'); },
  modelRouterRoute(body: ModelRouteRequest): Promise<ModelRouteDecision> {
    return modelRouterCall('/api/model-router/route', { method: 'POST', body: JSON.stringify(body) });
  },
  modelRouterRun(body: ModelRouteRequest): Promise<ModelRunResult> {
    return modelRouterCall('/api/model-router/run', { method: 'POST', body: JSON.stringify(body) }, (body.timeoutMs ?? 120_000) + 15_000);
  },
  // ── [/Model Router V1] ────────────────────────────────────────────────────────────────────────────────────────

  // ── [Document Toolbox PDF V1] ─────────────────────────────────────────────────────────────────────────────────
  toolboxUpload(file: File): Promise<{ ok: true; doc: ToolboxDoc }> {
    return toolboxCall('/api/document-toolbox/files', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
  },
  toolboxList(): Promise<{ ok: true; docs: ToolboxDoc[] }> { return toolboxCall('/api/document-toolbox/files'); },
  toolboxInfo(id: string): Promise<{ ok: true; doc: ToolboxDoc }> { return toolboxCall(`/api/document-toolbox/files/${encodeURIComponent(id)}`); },
  toolboxRemove(id: string): Promise<{ ok: true; removed: boolean }> { return toolboxCall(`/api/document-toolbox/files/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  toolboxText(id: string): Promise<{ ok: true; pages: Array<{ page: number; text: string }>; empty: boolean }> { return toolboxCall(`/api/document-toolbox/files/${encodeURIComponent(id)}/text`); },
  toolboxOperation(body: ToolboxOperation): Promise<ToolboxOperationResult> {
    return toolboxCall('/api/document-toolbox/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  toolboxDownloadUrl(id: string): string { return `${BASE}/api/document-toolbox/files/${encodeURIComponent(id)}/download`; },
  toolboxPageImageUrl(id: string, page: number, scale = 0.3): string { return `${BASE}/api/document-toolbox/files/${encodeURIComponent(id)}/pages/${page}/image?scale=${scale}`; },
  // ── [/Document Toolbox PDF V1] ────────────────────────────────────────────────────────────────────────────────

  // ── [Media Studio V1] ─────────────────────────────────────────────────────────────────────────────────────────
  mediaStudioListProjects(): Promise<{ ok: true; projects: MediaProjectSummary[] }> { return mediaStudioCall('/api/media-studio/projects'); },
  mediaStudioCreateProject(name?: string): Promise<MediaProjectView> {
    return mediaStudioCall('/api/media-studio/projects', { method: 'POST', body: JSON.stringify({ name }) });
  },
  mediaStudioGetProject(id: string): Promise<MediaProjectView> { return mediaStudioCall(`/api/media-studio/projects/${encodeURIComponent(id)}`); },
  mediaStudioEdit(id: string, edit: MediaEdit): Promise<MediaProjectView> {
    return mediaStudioCall(`/api/media-studio/projects/${encodeURIComponent(id)}/edits`, { method: 'POST', body: JSON.stringify(edit) });
  },
  mediaStudioRemoveAsset(id: string, assetId: string): Promise<MediaProjectView> {
    return mediaStudioCall(`/api/media-studio/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
  },
  /** Chunked upload (each request stays under the local body cap); the server decides the type from the bytes. */
  async mediaStudioUpload(projectId: string, file: Blob, name: string, opts: { onProgress?: (p: MediaUploadProgress) => void; signal?: AbortSignal; origin?: { type: 'media-reader'; url: string } } = {}): Promise<MediaProjectView & { asset: MediaAsset }> {
    if (file.size > MEDIA_STUDIO_MAX_BYTES) throw Object.assign(new Error('Fichier trop volumineux (1 Go maximum).'), { code: 'FILE_TOO_LARGE' });
    const { uploadId, chunkBytes } = await mediaStudioCall<{ uploadId: string; chunkBytes: number }>(`/api/media-studio/projects/${encodeURIComponent(projectId)}/uploads`, {
      method: 'POST', body: JSON.stringify({ name, size: file.size, origin: opts.origin }),
    });
    try {
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        if (opts.signal?.aborted) throw new DOMException('Envoi annulé', 'AbortError');
        await mediaStudioCall(`/api/media-studio/uploads/${uploadId}?offset=${offset}`, { method: 'PUT', body: file.slice(offset, offset + chunkBytes), headers: { 'Content-Type': 'application/octet-stream' }, signal: opts.signal }, 300_000);
        opts.onProgress?.({ sent: Math.min(offset + chunkBytes, file.size), total: file.size });
      }
      const sha256 = await sha256Hex(file);
      return await mediaStudioCall(`/api/media-studio/uploads/${uploadId}/complete`, { method: 'POST', body: JSON.stringify({ sha256 }) }, 300_000);
    } catch (err) {
      void fetchTimeout(`${BASE}/api/media-studio/uploads/${uploadId}`, { method: 'DELETE' }, 10_000).catch(() => {});
      throw err;
    }
  },
  mediaStudioImportImage(projectId: string, imageId: string): Promise<MediaProjectView & { asset: MediaAsset }> {
    return mediaStudioCall(`/api/media-studio/projects/${encodeURIComponent(projectId)}/import-image`, { method: 'POST', body: JSON.stringify({ imageId }) });
  },
  mediaStudioExport(projectId: string): Promise<{ ok: true; job: MediaExportJob }> {
    return mediaStudioCall(`/api/media-studio/projects/${encodeURIComponent(projectId)}/exports`, { method: 'POST' });
  },
  mediaStudioGetExport(jobId: string): Promise<{ ok: true; job: MediaExportJob }> { return mediaStudioCall(`/api/media-studio/exports/${encodeURIComponent(jobId)}`); },
  mediaStudioCancelExport(jobId: string): Promise<{ ok: true; job: MediaExportJob }> {
    return mediaStudioCall(`/api/media-studio/exports/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  },
  mediaStudioAssetUrl(projectId: string, assetId: string): string { return `${BASE}/api/media-studio/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/file`; },
  mediaStudioExportUrl(jobId: string, download = false): string { return `${BASE}/api/media-studio/exports/${encodeURIComponent(jobId)}/file${download ? '?download=1' : ''}`; },
  // ── [/Media Studio V1] ────────────────────────────────────────────────────────────────────────────────────────
};
