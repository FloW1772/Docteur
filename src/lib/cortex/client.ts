import type { Page, Block } from '../types';
import { pageToContent } from './pageToContent';

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
  before?: { fragments: number; rows: number };
  after?: { fragments: number; rows: number };
}

export interface IndexFragmentStats {
  numFragments: number;
  numSmallFragments: number;
  numRows: number;
  numIndices: number;
  totalBytes: number;
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
  sources: Array<{ id: string; title: string; score: number }>;
  latency_ms: number;
  model_used: string | null;
  router_level?: number | null;
  routing_reason?: string | null;
  has_private_sources?: boolean;
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

export interface RouterSettings {
  router_enabled: boolean;
  fallback_model: string;
  cloud_enabled: boolean;
  paying_apis_enabled: boolean;
  cloud_preference?: 'local' | 'balanced' | 'quality';
  strict_local_mode?: boolean;
  groq_model?: string;
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
  gemini_active:     boolean;
  groq_active:       boolean;
  openrouter_active: boolean;
  anthropic_active:  boolean;
  openai_active:     boolean;
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

export interface ResearchResult {
  content: string;
  model:   string;
  mode:    'synthese' | 'actualite';
  sources: ResearchSource[];
  warning?: string;
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
}

export interface DeepResearchPlanResult {
  subtopics: string[];
  model:     string;
}

export interface DeepResearchSectionResult {
  content: string;
  model:   string;
  sources: ResearchSource[];
}

export interface DeepCaptureResult {
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
  result?: { summary: string; model_used: string };
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
  triggered_by:     string;
}

export interface AgentRunOutput {
  ok:      boolean;
  run_id:  string;
  title:   string;
  content: string;
  kind:    string;
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
  neurons: Array<{ id: string; kind: string; title: string; content: string; metadata: Record<string, unknown> }>;
  links?: Array<{ from: string; to: string }>;
}

export interface PlaylistVideo {
  id:    string;
  title: string;
  url:   string;
}

export interface PlaylistInfo {
  title:       string;
  uploader:    string;
  playlistId:  string;
  video_count: number;
  videos:      PlaylistVideo[];
}

export interface ImportResult {
  ok: boolean;
  indexed: number;
  total: number;
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

// ── Internal fetch helpers ─────────────────────────────────────────────────

async function fetchTimeout(url: string, opts: RequestInit, timeoutMs = TIMEOUT): Promise<Response> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiFetch(path: string, opts: RequestInit = {}, timeoutMs = TIMEOUT): Promise<Response> {
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
  throw lastErr;
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

// ── Singleton client ───────────────────────────────────────────────────────

export const cortexClient = {
  get isAvailable(): boolean { return _available; },
  get lastCheck(): Date | null { return _lastCheck; },

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
        metadata: { tags: page.tags ?? [], updatedAt: page.updatedAt },
      }),
    }, 60_000); // embedding can take longer when Ollama is under load
    if (!res.ok) throw new Error(`Index HTTP ${res.status}`);
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
  ): Promise<CaptureResult & { fallback?: boolean; reason?: string; model_used?: string }> {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000); // texte peut être long
    signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(`${BASE}/api/capture/deep`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, source, ...(url ? { url } : {}) }),
        signal:  ctrl.signal,
      });
      if (!res.ok) throw new Error(`Deep capture text HTTP ${res.status}`);
      return res.json() as Promise<CaptureResult & { fallback?: boolean; reason?: string; model_used?: string }>;
    } finally {
      clearTimeout(timer);
    }
  },

  async captureDeep(url: string, signal?: AbortSignal, captureImages = false): Promise<DeepCaptureResult> {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(`${BASE}/api/capture/deep`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, captureImages }),
        signal:  ctrl.signal,
      });
      if (!res.ok) throw new Error(`Deep capture HTTP ${res.status}`);
      return res.json() as Promise<DeepCaptureResult>;
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

  async getPlaylist(url: string): Promise<PlaylistInfo> {
    const res = await apiFetch('/api/capture/playlist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    }, 40_000);
    if (!res.ok) {
      const err = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(err);
    }
    return res.json() as Promise<PlaylistInfo>;
  },

  async deleteNeuron(id: string): Promise<{ ok: boolean }> {
    const res = await apiFetch(`/api/neuron/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete HTTP ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  },

  async optimizeIndex(): Promise<IndexOptimizeResult> {
    const res = await apiFetch('/api/index/optimize', { method: 'POST' });
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

  async testCloudKey(provider: string, key?: string): Promise<{ ok: boolean; model?: string; error?: string }> {
    const res = await apiFetch(`/api/router/test/${provider}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: key ?? '' }),
    }, 15_000);
    return res.json() as Promise<{ ok: boolean; model?: string; error?: string }>;
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

  async research(subject: string, mode: 'synthese' | 'actualite'): Promise<ResearchResult> {
    const res = await apiFetch('/api/research', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, mode }),
    }, 120_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `Research HTTP ${res.status}`);
    }
    return res.json() as Promise<ResearchResult>;
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
  ): Promise<DeepResearchSectionResult> {
    const res = await apiFetch('/api/research/deep/section', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, subtopic, index, total, source, otherTopics }),
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
  ): Promise<DeepResearchSectionResult> {
    const res = await apiFetch('/api/research/deep/document', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, depth, source }),
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

  async multiResearchSource(subject: string, angle: string): Promise<{ content: string; model: string; sources: ResearchSource[]; angle: string }> {
    const res = await apiFetch('/api/research/multi/source', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, angle }),
    }, 90_000);
    if (!res.ok) {
      const raw = await res.json().catch(() => ({})) as { error?: string; quota?: boolean; grounding_unavailable?: boolean };
      throw Object.assign(new Error(raw.error ?? `Source HTTP ${res.status}`), { quota: raw.quota, grounding_unavailable: raw.grounding_unavailable });
    }
    return res.json() as Promise<{ content: string; model: string; sources: ResearchSource[]; angle: string }>;
  },

  async multiResearchCrosscheck(subject: string, sources: Array<{ angle: string; content: string }>): Promise<{ synthesis: string; model: string }> {
    const res = await apiFetch('/api/research/multi/crosscheck', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subject, sources }),
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
    params:     { transcription: string; level: ResummariseLevel; focus?: string; use_powerful?: boolean },
    onProgress: (p: ResummariseProgress) => void,
    signal?:    AbortSignal,
  ): Promise<{ summary: string; model_used: string }> {
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

  async updateJob(id: string, update: Partial<Pick<ServerJob, 'current' | 'currentLabel' | 'okCount' | 'fallbackCount' | 'errorCount'>>): Promise<void> {
    if (!id) return;
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(id)}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(update),
      }, 5_000);
    } catch { /* non-critical, ignore */ }
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
};
