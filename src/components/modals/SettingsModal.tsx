import { Fragment, useEffect, useState, useCallback, useRef } from 'react';
import { X, Cpu, RefreshCw, CheckCircle, AlertTriangle, Download, Merge, Eye, EyeOff, Zap, Upload, Link2, Trash2, Plus, ShieldCheck, Mic, HardDrive, ShieldAlert, FileText } from 'lucide-react';
import { FreeAiFinder } from '../settings/FreeAiFinder';
import { exportAllToServer } from '../../lib/storage';
import ExternalAgentsPanel from '../panels/ExternalAgentsPanel';
import { ImagesSettingsTab } from '../settings/ImagesSettingsTab';
import { cortexClient } from '../../lib/cortex/client';
import type { RouterModelStatus, RouterSettings, RouterStat, CloudKeysMasked, CloudMonthStat, PrivacyViolation, PrivacyTestResult, VoiceSettings, InboxSettings, InboxCheckResult, PersonaSettings, PreferenceFact, OllamaModelsResult, FilesIndexResult, FileDetailResult, FileResultSummary, FileOriginalSummary, FileCompetenceInfo, WhisperStats, IndexFragmentStats, AudioPlayerSettings, ProvidersOverviewResult, ProviderHealthState } from '../../lib/cortex/client';

const PROVIDER_STATE_LABELS: Record<ProviderHealthState, string> = {
  ready:              'CONNECTÉ',
  rate_limited:       'LIMITE DE DÉBIT',
  quota_exhausted:    'QUOTA ÉPUISÉ',
  auth_required:      'AUTH REQUISE',
  offline:            'HORS LIGNE',
  model_unavailable:  'MODÈLE INDISPONIBLE',
  error:              'ERREUR',
  degraded:           'DÉGRADÉ',
  timeout:            'TIMEOUT',
};

const PROVIDER_STATE_COLORS: Record<ProviderHealthState, string> = {
  ready:             '#3dffaa',
  rate_limited:      '#f59e0b',
  quota_exhausted:   '#f59e0b',
  auth_required:     '#ff4d58',
  offline:           '#ff4d58',
  model_unavailable: '#ff4d58',
  error:             '#ff4d58',
  degraded:          '#f59e0b',
  timeout:           '#f59e0b',
};

function formatCooldown(ms: number): string {
  if (ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.ceil(totalSec / 60)}min`;
}
import { OLLAMA_RECOMMENDED_MODELS, formatBytes, formatGiB, isStrictOllamaModelName, fitsVramBudget, VRAM_BUDGET_GIB } from '../../lib/ollamaModels';

type Tab = 'models' | 'stats' | 'privacy' | 'vocal' | 'inbox' | 'files' | 'audio' | 'external' | 'images';

// ── Cloud provider definitions ─────────────────────────────────────────────

interface ProviderDef {
  id:    'gemini' | 'groq' | 'openrouter' | 'anthropic' | 'openai' | 'freellmapi' | 'claude-oauth' | 'codex';
  label: string;
  note:  string;
  color: string;
  free:  boolean;
}

const CLOUD_PROVIDERS: ProviderDef[] = [
  { id: 'gemini',     label: 'Google Gemini',  note: 'gemini-2.0-flash (gratuit)', color: '#5ee7ff', free: true  },
  { id: 'groq',       label: 'Groq',           note: 'openai/gpt-oss-120b (gratuit)', color: '#f97316', free: true  },
  { id: 'openrouter', label: 'OpenRouter',      note: 'nemotron-120b:free (dernier recours)', color: '#3dffaa', free: true  },
  { id: 'anthropic',  label: 'Anthropic Claude',note: 'claude-haiku (payant)',      color: '#a78bfa', free: false },
  { id: 'openai',     label: 'OpenAI',          note: 'gpt-4o-mini (payant)',       color: '#f59e0b', free: false },
  { id: 'freellmapi', label: 'FreeLLMAPI',      note: 'Gateway configurable ; gratuité non garantie par l API', color: '#22d3ee', free: false },
  { id: 'claude-oauth', label: 'Claude Code',   note: 'OAuth (payant)',            color: '#8b5cf6', free: false },
  { id: 'codex',      label: 'Codex',           note: 'OpenAI Codex (payant)',      color: '#0ea5e9', free: false },
];

interface Props {
  onClose:                   () => void;
  onMergeDuplicates?:        () => Promise<number>;
  downloadFolder?:           string;
  onDownloadFolderChange?:   (folder: string) => void;
  batchSize?:                number;
  batchDelay?:               number;
  onBatchSizeChange?:        (n: number) => void;
  onBatchDelayChange?:       (ms: number) => void;
  showHomeScreen?:           boolean;
  onShowHomeScreenChange?:   (v: boolean) => void;
  captureImages?:            boolean;
  onCaptureImagesChange?:    (v: boolean) => void;
  transferImages?:           boolean;
  onTransferImagesChange?:   (v: boolean) => void;
  customShortcuts?:          Record<string, string>;
  onSetShortcut?:            (name: string, url: string) => Promise<void>;
  onDeleteShortcut?:         (name: string) => Promise<void>;
  onInboxImport?:            (result: InboxCheckResult) => void;
  onRepairDone?:             () => Promise<void>;
  corpusCount?:              number;
  gestureSensitivity?:          number;
  onGestureSensitivityChange?:  (value: number) => void;
  easterEggEnabled?:            boolean;
  onEasterEggEnabledChange?:    (v: boolean) => void;
}

const LEVEL_COLORS: Record<number, string> = {
  1: '#7a6c9a',
  2: '#5ee7ff',
  3: '#3dffaa',
};

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function sameOllamaModelGroup(actual: string, expected: string): boolean {
  const left = String(actual ?? '').trim().split('@')[0];
  const right = String(expected ?? '').trim().split('@')[0];
  if (!left || !right) return false;
  if (left === right) return true;
  const [leftBase, leftTag = ''] = left.split(':');
  const [rightBase, rightTag = ''] = right.split(':');
  if (leftBase !== rightBase) return false;
  if (!leftTag || !rightTag) return true;
  return leftTag === rightTag;
}

export default function SettingsModal({
  onClose, onMergeDuplicates,
  downloadFolder = 'D:\\upload', onDownloadFolderChange,
  batchSize = 5, batchDelay = 1500, onBatchSizeChange, onBatchDelayChange,
  showHomeScreen = true, onShowHomeScreenChange,
  captureImages = false, onCaptureImagesChange,
  transferImages = false, onTransferImagesChange,
  customShortcuts = {}, onSetShortcut, onDeleteShortcut,
  onInboxImport,
  onRepairDone,
  corpusCount = 0,
  gestureSensitivity = 5,
  onGestureSensitivityChange,
  easterEggEnabled = true,
  onEasterEggEnabledChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('models');
  const [audioSettings, setAudioSettings] = useState<AudioPlayerSettings | null>(null);
  const [audioError, setAudioError]       = useState<string | null>(null);
  const [audioFolderDraft, setAudioFolderDraft] = useState('');
  const [newStreamName, setNewStreamName] = useState('');
  const [newStreamUrl, setNewStreamUrl]   = useState('');
  const [imageStats, setImageStats] = useState<{ count: number; totalMb: number } | null>(null);
  const [privacyViolations, setPrivacyViolations]     = useState<PrivacyViolation[]>([]);
  const [privacyTestResult,  setPrivacyTestResult]    = useState<PrivacyTestResult | null>(null);
  const [privacyTestRunning, setPrivacyTestRunning]   = useState(false);
  const [privacyTestError,   setPrivacyTestError]     = useState<string | null>(null);
  const [voiceSettings,      setVoiceSettings]        = useState<VoiceSettings | null>(null);
  const [voiceSaving,        setVoiceSaving]          = useState(false);
  const [voiceError,         setVoiceError]           = useState<string | null>(null);
  const [ppnUploading,       setPpnUploading]         = useState(false);
  const ppnInputRef = useRef<HTMLInputElement>(null);
  const [personaSettings, setPersonaSettings] = useState<PersonaSettings | null>(null);
  const [preferenceFacts, setPreferenceFacts] = useState<PreferenceFact[]>([]);
  const [editingFactId,   setEditingFactId]   = useState<string | null>(null);
  const [editingFactText, setEditingFactText] = useState('');
  const [newFactText,     setNewFactText]     = useState('');
  const [factError,       setFactError]       = useState<string | null>(null);
  const [inboxSettings,   setInboxSettings]   = useState<InboxSettings | null>(null);
  const [inboxSaving,     setInboxSaving]     = useState(false);
  const [inboxChecking,   setInboxChecking]   = useState(false);
  const [inboxCheckResult,setInboxCheckResult]= useState<InboxCheckResult | null>(null);
  const [inboxError,      setInboxError]      = useState<string | null>(null);
  const [filesIndex,      setFilesIndex]      = useState<FilesIndexResult | null>(null);
  const [filesLoading,    setFilesLoading]    = useState(false);
  const [filesError,      setFilesError]      = useState<string | null>(null);
  const [filesUploading,  setFilesUploading]  = useState(false);
  const [selectedOriginalId, setSelectedOriginalId] = useState<string | null>(null);
  const [selectedFileDetail, setSelectedFileDetail] = useState<FileDetailResult | null>(null);
  const [processingOriginalId, setProcessingOriginalId] = useState<string | null>(null);
  const [cloudConfirmation, setCloudConfirmation] = useState<string | null>(null);
  const [scName, setScName]       = useState('');
  const [scUrl,  setScUrl]        = useState('');
  const [scError, setScError]     = useState<string | null>(null);
  const [scSaving, setScSaving]   = useState(false);

  async function addShortcut() {
    const name = scName.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const url  = scUrl.trim();
    if (!name || /\s/.test(name)) { setScError('Le nom ne doit pas contenir d\'espace'); return; }
    try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(); }
    catch { setScError('URL invalide — uniquement http/https'); return; }
    setScSaving(true);
    try {
      await onSetShortcut?.(name, url);
      setScName('');
      setScUrl('');
      setScError(null);
    } catch (e) {
      setScError(e instanceof Error ? e.message : 'Erreur');
    } finally {
      setScSaving(false);
    }
  }

  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [statuses, setStatuses]   = useState<RouterModelStatus[]>([]);
  const [settings, setSettings]   = useState<RouterSettings>({
    router_enabled:   true,
    fallback_model:   'llama3.2:3b',
    cloud_enabled:    false,
    paying_apis_enabled: false,
    cloud_preference: 'local',
    groq_model:       'openai/gpt-oss-120b',
    powerful_model:   'qwen2.5:14b-instruct-q3_K_M',
    chat_model:       'mistral-nemo:12b-instruct-2407-q4_K_M',
    freellmapi: {
      enabled: false, baseUrl: '', timeout: 90000, mode: 'auto', allowText: true,
      allowImage: false, allowVideo: false, allowAudio: false, allowFallback: true,
      freeOnly: false, textModel: 'auto', imageModel: 'auto', videoModel: 'auto', audioModel: 'auto',
    },
  });
  const [stats, setStats]             = useState<RouterStat[]>([]);
  const [cloudMonth, setCloudMonth]   = useState<CloudMonthStat[]>([]);
  const [cloudKeys, setCloudKeys]     = useState<CloudKeysMasked | null>(null);
  const [providersOverview, setProvidersOverview] = useState<ProvidersOverviewResult | null>(null);
  const [keyDrafts, setKeyDrafts]     = useState<Record<string, string>>({});
  const [keyVisible, setKeyVisible]   = useState<Record<string, boolean>>({});
  const [keyTesting, setKeyTesting]   = useState<Record<string, boolean>>({});
  const [keyTestResult, setKeyTestResult] = useState<Record<string, { ok: boolean; msg: string } | null>>({});
  const [freeModels, setFreeModels] = useState<Array<{ id: string; free?: boolean; capabilities: string[] }>>([]);
  const [geminiRpm, setGeminiRpm]     = useState<number>(10);
  const [ollamaOk, setOllamaOk]      = useState(true);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelsResult | null>(null);
  const [customModelName, setCustomModelName] = useState('');
  const [customModelError, setCustomModelError] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<{ model: string; status: string; percent: number; completed: number; total: number | null } | null>(null);
  const modelAbortRef = useRef<AbortController | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [merging, setMerging]         = useState(false);
  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const [syncing, setSyncing]         = useState(false);
  const [syncDone, setSyncDone]       = useState(0);
  const [syncTotal, setSyncTotal]     = useState(0);
  const [syncResult, setSyncResult]   = useState<string | null>(null);
  const [repairing, setRepairing]     = useState(false);
  const [repairResult, setRepairResult] = useState<string | null>(null);
  const [whisperStats, setWhisperStats] = useState<WhisperStats | null>(null);
  const [indexStats, setIndexStats]     = useState<IndexFragmentStats | null>(null);
  const [optimizing, setOptimizing]     = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<string | null>(null);
  const [styleExamplesEnabled, setStyleExamplesEnabled] = useState(false);

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [statusRes, statsRes, rpm, ollamaRes, styleSettings, providersRes] = await Promise.all([
        cortexClient.routerStatus(),
        cortexClient.routerStats(),
        cortexClient.getGeminiRpm(),
        cortexClient.ollamaModels(),
        cortexClient.getStyleExampleSettings(),
        cortexClient.getProvidersOverview().catch(() => null),
      ]);
      setStatuses(statusRes.statuses);
      setSettings(statusRes.settings);
      setOllamaOk(statusRes.ollama_connected && ollamaRes.connected);
      setOllamaModels(ollamaRes);
      setStats(statsRes.stats);
      setCloudMonth(statsRes.cloud_month ?? []);
      setGeminiRpm(rpm);
      setStyleExamplesEnabled(styleSettings.enabled);
      if (statusRes.cloud_keys) setCloudKeys(statusRes.cloud_keys);
      if (providersRes) setProvidersOverview(providersRes);
    } catch (e) {
      setError('Serveur cognitif inaccessible');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (tab !== 'privacy') return;
    cortexClient.privacyViolations(100).then(r => setPrivacyViolations(r.violations)).catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (tab !== 'stats') return;
    cortexClient.getWhisperStats().then(setWhisperStats).catch(() => {});
    cortexClient.getIndexStats().then(r => setIndexStats(r)).catch(() => {});
    setOptimizeResult(null);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'vocal') return;
    cortexClient.getVoiceSettings().then(setVoiceSettings).catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (tab !== 'inbox') return;
    setInboxError(null);
    cortexClient.getInboxSettings().then(setInboxSettings).catch(() => setInboxError('Cortex indisponible'));
  }, [tab]);

  useEffect(() => {
    if (tab !== 'audio') return;
    setAudioError(null);
    cortexClient.getAudioPlayerSettings()
      .then((s) => { setAudioSettings(s); setAudioFolderDraft(s.localFolder ?? ''); })
      .catch(() => setAudioError('Réglages audio indisponibles'));
  }, [tab]);

  async function saveAudioFolder() {
    try {
      const res = await cortexClient.setAudioPlayerSettings({ localFolder: audioFolderDraft.trim() || null });
      setAudioSettings(res.settings);
    } catch {
      setAudioError('Impossible d\'enregistrer le dossier.');
    }
  }

  async function addAudioStream() {
    if (!audioSettings || !newStreamName.trim() || !/^https?:\/\//i.test(newStreamUrl.trim())) return;
    const customStreams = [...audioSettings.customStreams, { name: newStreamName.trim(), url: newStreamUrl.trim() }];
    try {
      const res = await cortexClient.setAudioPlayerSettings({ customStreams });
      setAudioSettings(res.settings);
      setNewStreamName('');
      setNewStreamUrl('');
    } catch {
      setAudioError('Impossible d\'ajouter ce flux.');
    }
  }

  async function removeAudioStream(index: number) {
    if (!audioSettings) return;
    const customStreams = audioSettings.customStreams.filter((_, i) => i !== index);
    try {
      const res = await cortexClient.setAudioPlayerSettings({ customStreams });
      setAudioSettings(res.settings);
    } catch {
      setAudioError('Impossible de supprimer ce flux.');
    }
  }

  useEffect(() => {
    if (tab !== 'files') return;
    setFilesLoading(true);
    setFilesError(null);
    cortexClient.filesIndex()
      .then((index) => {
        setFilesIndex(index);
        setSelectedOriginalId((current) => current && index.originals.some(item => item.id === current) ? current : index.originals[0]?.id ?? null);
      })
      .catch((error) => setFilesError(error instanceof Error ? error.message : 'Erreur fichiers'))
      .finally(() => setFilesLoading(false));
  }, [tab]);

  useEffect(() => {
    if (tab !== 'files' || !selectedOriginalId) return;
    cortexClient.getFileOriginal(selectedOriginalId)
      .then(setSelectedFileDetail)
      .catch((error) => setFilesError(error instanceof Error ? error.message : 'Erreur détails fichier'));
  }, [tab, selectedOriginalId]);

  async function refreshFiles(selectId?: string) {
    const index = await cortexClient.filesIndex();
    setFilesIndex(index);
    const nextId = selectId ?? selectedOriginalId ?? index.originals[0]?.id ?? null;
    setSelectedOriginalId(nextId && index.originals.some(item => item.id === nextId) ? nextId : index.originals[0]?.id ?? null);
    if (nextId) {
      try {
        const detail = await cortexClient.getFileOriginal(nextId);
        setSelectedFileDetail(detail);
      } catch (error) {
        setFilesError(error instanceof Error ? error.message : 'Erreur détails fichier');
      }
    }
  }

  async function handleFileUpload(file: File) {
    setFilesUploading(true);
    setFilesError(null);
    try {
      const result = await cortexClient.uploadFile(file);
      await refreshFiles(result.original.id);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Erreur upload');
    } finally {
      setFilesUploading(false);
    }
  }

  async function handleFileSelection(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    for (const file of list) {
      await handleFileUpload(file);
    }
  }

  async function handleProcessFile(original: FileOriginalSummary, competence: FileCompetenceInfo) {
    if (competence.cloud) {
      const confirmCloud = window.confirm(`La compétence "${competence.label}" est cloud. Aucun envoi ne sera fait sans accord explicite.`);
      if (!confirmCloud) return;
      setCloudConfirmation(competence.label);
    }
    setProcessingOriginalId(original.id);
    setFilesError(null);
    try {
      await cortexClient.processFile(original.id, competence.id, competence.cloud);
      await refreshFiles(original.id);
    } catch (error) {
      if (error instanceof Error && (error as Error & { cloud_required?: boolean }).cloud_required) {
        setFilesError(error.message);
      } else {
        setFilesError(error instanceof Error ? error.message : 'Erreur traitement');
      }
    } finally {
      setProcessingOriginalId(null);
      setCloudConfirmation(null);
    }
  }

  async function handleDeleteOriginal(original: FileOriginalSummary) {
    const hasResults = (original.treatments_count ?? 0) > 0;
    const ok = window.confirm(hasResults
      ? `Supprimer l'original "${original.original_name}" et ses ${original.treatments_count} résultat(s) ?`
      : `Supprimer l'original "${original.original_name}" ?`);
    if (!ok) return;
    try {
      await cortexClient.deleteFileOriginal(original.id, hasResults);
      await refreshFiles();
      if (selectedOriginalId === original.id) setSelectedFileDetail(null);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Erreur suppression');
    }
  }

  async function handleDeleteResult(result: FileResultSummary) {
    const ok = window.confirm(`Supprimer le résultat "${result.stored_name}" ?`);
    if (!ok) return;
    try {
      await cortexClient.deleteFileResult(result.id);
      await refreshFiles(result.original_id);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Erreur suppression');
    }
  }

  async function handleRestoreResult(result: FileResultSummary) {
    try {
      await cortexClient.restoreFileResult(result.id);
      await refreshFiles(result.original_id);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : 'Erreur restauration');
    }
  }

  async function saveVoiceSetting(updates: Partial<VoiceSettings>) {
    setVoiceSaving(true);
    setVoiceError(null);
    try {
      await cortexClient.updateVoiceSettings(updates);
      setVoiceSettings(prev => prev ? { ...prev, ...updates } : null);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : 'Erreur');
    } finally {
      setVoiceSaving(false);
    }
  }

  async function handlePpnUpload(file: File) {
    setPpnUploading(true);
    setVoiceError(null);
    try {
      await cortexClient.uploadPorcupineModel(file);
      setVoiceSettings(prev => prev ? { ...prev, hasPorcupineModel: true } : null);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : 'Erreur upload');
    } finally {
      setPpnUploading(false);
    }
  }

  async function saveInboxSetting(updates: Partial<InboxSettings>) {
    setInboxSaving(true);
    setInboxError(null);
    try {
      const updated = await cortexClient.updateInboxSettings(updates);
      setInboxSettings(updated);
    } catch (e) {
      setInboxError(e instanceof Error ? e.message : 'Erreur');
    } finally {
      setInboxSaving(false);
    }
  }

  async function handleCheckNow() {
    setInboxChecking(true);
    setInboxError(null);
    setInboxCheckResult(null);
    try {
      const result = await cortexClient.checkInboxNow();
      setInboxCheckResult(result);
      if (result.processed > 0) onInboxImport?.(result);
    } catch (e) {
      setInboxError(e instanceof Error ? e.message : 'Erreur vérification');
    } finally {
      setInboxChecking(false);
    }
  }

  useEffect(() => {
    cortexClient.getPersonaSettings().then(setPersonaSettings).catch(() => {});
    cortexClient.listPreferenceFacts().then(setPreferenceFacts).catch(() => {});
  }, []);

  async function handleAddFact() {
    const text = newFactText.trim();
    if (!text) return;
    setFactError(null);
    try {
      const created = await cortexClient.addPreferenceFact(text);
      setPreferenceFacts(prev => [...prev, created]);
      setNewFactText('');
    } catch (e) {
      setFactError(e instanceof Error ? e.message : 'Erreur');
    }
  }

  async function handleSaveFactEdit(id: string) {
    const text = editingFactText.trim();
    if (!text) return;
    try {
      await cortexClient.updatePreferenceFact(id, text);
      setPreferenceFacts(prev => prev.map(f => f.id === id ? { ...f, fact: text } : f));
      setEditingFactId(null);
    } catch (e) {
      setFactError(e instanceof Error ? e.message : 'Erreur');
    }
  }

  async function handleDeleteFact(id: string) {
    try {
      await cortexClient.deletePreferenceFact(id);
      setPreferenceFacts(prev => prev.filter(f => f.id !== id));
    } catch (e) {
      setFactError(e instanceof Error ? e.message : 'Erreur');
    }
  }

  async function handleClearAllFacts() {
    if (!window.confirm('Effacer tous les faits retenus ?')) return;
    try {
      await cortexClient.clearPreferenceFacts();
      setPreferenceFacts([]);
    } catch (e) {
      setFactError(e instanceof Error ? e.message : 'Erreur');
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleToggleRouter() {
    setSaving(true);
    try {
      const updated = { router_enabled: !settings.router_enabled };
      const res = await cortexClient.updateRouterSettings(updated);
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  async function handleSetClaudeMode(mode: 'subscription' | 'api') {
    setSaving(true);
    try {
      const res = await cortexClient.updateRouterSettings({ claude_mode: mode });
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  async function handleSetOpenaiMode(mode: 'subscription' | 'api') {
    setSaving(true);
    try {
      const res = await cortexClient.updateRouterSettings({ openai_mode: mode });
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStrictLocal() {
    setSaving(true);
    try {
      const res = await cortexClient.updateRouterSettings({ strict_local_mode: !settings.strict_local_mode });
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStyleExamples() {
    setSaving(true);
    try {
      const res = await cortexClient.setStyleExampleSettings(!styleExamplesEnabled);
      setStyleExamplesEnabled(res.enabled);
    } finally {
      setSaving(false);
    }
  }

  async function handleFallbackChange(model: string) {
    setSaving(true);
    try {
      const res = await cortexClient.updateRouterSettings({ fallback_model: model });
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  async function handlePowerfulModelChange(model: string) {
    setSaving(true);
    try {
      const res = await cortexClient.updateRouterSettings({ powerful_model: model });
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  async function handleChatModelChange(model: string) {
    setSaving(true);
    try {
      const res = await cortexClient.updateRouterSettings({ chat_model: model });
      setSettings(res.settings);
    } finally {
      setSaving(false);
    }
  }

  const installedOllamaModels = ollamaModels?.models ?? [];
  const installedModelNames = new Set(installedOllamaModels.map(model => model.name));
  const installedRecommendedModels = OLLAMA_RECOMMENDED_MODELS.filter((model) =>
    installedOllamaModels.some((installed) => sameOllamaModelGroup(installed.name, model.name)),
  );
  const extraInstalledModels = installedOllamaModels.filter((installed) =>
    !OLLAMA_RECOMMENDED_MODELS.some((model) => sameOllamaModelGroup(installed.name, model.name)),
  );
  const totalInstalledBytes = installedOllamaModels.reduce((sum, model) => sum + (Number.isFinite(model.size) ? model.size : 0), 0);
  const freeBytes = ollamaModels?.free_bytes ?? null;
  const canManageModels = ollamaOk && !loading && !error;
  const isModelBusy = (name: string) => modelBusy === name;

  function stopModelAction() {
    modelAbortRef.current?.abort();
    modelAbortRef.current = null;
    setModelBusy(null);
    setModelProgress(null);
  }

  async function refreshModels() {
    await fetchStatus(true);
  }

  async function handleInstallModel(model: string) {
    const trimmed = model.trim();
    if (!isStrictOllamaModelName(trimmed)) {
      setCustomModelError('Nom de modèle invalide');
      return;
    }
    if (modelBusy) return;
    setModelMessage(null);
    setCustomModelError(null);
    setModelBusy(trimmed);
    const controller = new AbortController();
    modelAbortRef.current = controller;
    try {
      await cortexClient.pullOllamaModel(trimmed, (event) => {
        if (event.error) {
          setModelProgress({ model: trimmed, status: event.error, percent: 0, completed: 0, total: null });
          return;
        }
        const percent = event.total && event.completed != null ? Math.min(100, Math.round((event.completed / event.total) * 100)) : 0;
        setModelProgress({
          model: trimmed,
          status: event.status ?? 'Téléchargement…',
          percent,
          completed: event.completed ?? 0,
          total: event.total ?? null,
        });
      }, controller.signal);
      setModelMessage(`Modèle installé : ${trimmed}`);
      await refreshModels();
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
      setModelMessage(aborted ? 'Installation annulée' : (error instanceof Error ? error.message : 'Erreur installation'));
    } finally {
      modelAbortRef.current = null;
      setModelBusy(null);
      setModelProgress(null);
    }
  }

  async function handleDeleteModel(model: string) {
    if (!window.confirm(`Desinstaller ${model} ? Cette action est irreversible.`)) return;
    if (modelBusy) return;
    setModelBusy(model);
    try {
      await cortexClient.deleteOllamaModel(model);
      setModelMessage(`Modèle supprimé : ${model}`);
      await refreshModels();
    } catch (e) {
      setModelMessage(e instanceof Error ? e.message : 'Erreur suppression');
    } finally {
      setModelBusy(null);
    }
  }

  async function handleCustomModelInstall() {
    const trimmed = customModelName.trim();
    if (!isStrictOllamaModelName(trimmed)) {
      setCustomModelError('Nom invalide : caractères autorisés uniquement alphanumériques, -, ., :, /');
      return;
    }
    await handleInstallModel(trimmed);
    setCustomModelName('');
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(980px, calc(100vw - 24px))',
          border: '1px solid rgba(61,255,170,0.18)',
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 30px 90px rgba(0,0,0,0.56)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(61,255,170,0.1)' }}>
          <Cpu size={15} style={{ color: '#3dffaa', flexShrink: 0 }} />
          <div className="flex-1">
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Paramètres — Router intelligent
            </h3>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
              Ctrl+, · Sélection automatique du LLM selon la complexité
            </p>
          </div>
          <button type="button" style={{ color: '#5a4a7a' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto" style={{ borderBottom: '1px solid rgba(61,255,170,0.08)', padding: '0 20px' }}>
          {(['models', 'stats', 'privacy', 'vocal', 'inbox', 'files', 'audio', 'external', 'images'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="font-mono text-xs py-2.5 px-4 relative"
              style={{
                color:  tab === t ? '#3dffaa' : '#5a4a7a',
                borderBottom: tab === t ? '2px solid #3dffaa' : '2px solid transparent',
                letterSpacing: '0.1em',
              }}
            >
              {t === 'external' ? 'AGENTS EXTERNES' : t === 'models' ? 'MODÈLES' : t === 'stats' ? 'STATISTIQUES' : t === 'privacy' ? 'CONFIDENTIALITÉ' : t === 'vocal' ? 'VOCAL' : t === 'inbox' ? 'INBOX' : t === 'files' ? 'FICHIERS' : t === 'images' ? 'IMAGES' : 'AUDIO'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {tab === 'external' && <ExternalAgentsPanel />}
          {tab === 'images' && <ImagesSettingsTab strictLocalMode={!!settings.strict_local_mode} />}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <RefreshCw size={16} className="animate-spin" style={{ color: '#3d3060' }} />
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-10">
              <AlertTriangle size={18} style={{ color: '#ff4d58' }} />
              <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>
              <button type="button" onClick={() => fetchStatus()} className="font-mono text-xs flex items-center gap-2 px-4 py-2 rounded"
                style={{ border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff', background: 'transparent' }}>
                <RefreshCw size={11} /> Réessayer
              </button>
            </div>
          )}

          {!loading && !error && tab === 'models' && (
            <div className="px-5 py-4 flex flex-col gap-5">
              {/* Personnalité — tutoiement / vouvoiement */}
              {personaSettings !== null && (
                <div>
                  <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>PERSONNALITÉ</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {([false, true] as const).map(v => (
                      <button
                        key={String(v)} type="button"
                        onClick={() => {
                          cortexClient.updatePersonaSettings({ vouvoiement: v })
                            .then(setPersonaSettings).catch(() => {});
                        }}
                        style={{
                          flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                          fontFamily: 'monospace',
                          border: personaSettings.vouvoiement === v ? '1px solid #5ee7ff' : '1px solid rgba(255,255,255,0.1)',
                          background: personaSettings.vouvoiement === v ? 'rgba(94,231,255,0.08)' : 'rgba(255,255,255,0.02)',
                          color: personaSettings.vouvoiement === v ? '#5ee7ff' : '#7a6c9a',
                        }}
                      >
                        {v ? 'Vouvoiement' : 'Tutoiement'}
                      </button>
                    ))}
                  </div>
                  <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', marginTop: 4 }}>
                    Définit comment Docteur s'adresse à toi dans toutes ses réponses.
                  </p>
                </div>
              )}

              {/* Mémoire des préférences — mode Discussion */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="font-mono" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                    MÉMOIRE ({preferenceFacts.length}/50)
                  </p>
                  {preferenceFacts.length > 0 && (
                    <button type="button" onClick={() => void handleClearAllFacts()} className="font-mono text-[10px]" style={{ color: '#ff4d58', background: 'none', border: 'none', cursor: 'pointer' }}>
                      Tout effacer
                    </button>
                  )}
                </div>
                <p className="font-mono text-[10px] mb-2" style={{ color: '#5a4a7a' }}>
                  Faits que Docteur retient sur toi en mode Discussion (jamais un historique complet — seulement ce que tu confirmes).
                </p>
                {preferenceFacts.length === 0 && (
                  <p className="font-mono text-xs" style={{ color: '#3d3060' }}>Aucun fait retenu pour l'instant.</p>
                )}
                <div className="flex flex-col gap-1.5">
                  {preferenceFacts.map(f => (
                    <div key={f.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      {editingFactId === f.id ? (
                        <>
                          <input
                            type="text" value={editingFactText} maxLength={300}
                            onChange={e => setEditingFactText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') void handleSaveFactEdit(f.id); if (e.key === 'Escape') setEditingFactId(null); }}
                            className="font-mono text-xs flex-1 bg-transparent border-0 outline-none"
                            style={{ color: '#f0eaff' }}
                            autoFocus
                          />
                          <button type="button" onClick={() => void handleSaveFactEdit(f.id)} className="font-mono text-[10px]" style={{ color: '#3dffaa', background: 'none', border: 'none', cursor: 'pointer' }}>OK</button>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-xs flex-1" style={{ color: '#c0b0e0' }}>{f.fact}</span>
                          <button type="button" onClick={() => { setEditingFactId(f.id); setEditingFactText(f.fact); }} className="font-mono text-[10px]" style={{ color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer' }}>Modifier</button>
                          <button type="button" onClick={() => void handleDeleteFact(f.id)} className="font-mono text-[10px]" style={{ color: '#ff4d58', background: 'none', border: 'none', cursor: 'pointer' }}>Suppr.</button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {preferenceFacts.length < 50 && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="text" value={newFactText} maxLength={300}
                      onChange={e => setNewFactText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleAddFact(); }}
                      placeholder="Ajouter un fait manuellement…"
                      className="font-mono text-xs flex-1 px-2.5 py-1.5 rounded"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#f0eaff' }}
                    />
                    <button type="button" onClick={() => void handleAddFact()} className="font-mono text-[10px] px-2.5 py-1.5 rounded" style={{ background: 'rgba(61,255,170,0.1)', border: '1px solid rgba(61,255,170,0.25)', color: '#3dffaa', cursor: 'pointer' }}>
                      Ajouter
                    </button>
                  </div>
                )}
                {factError && <p className="font-mono text-[10px] mt-1" style={{ color: '#ff4d58' }}>{factError}</p>}
              </div>

              {/* Ollama status */}
              <div className="flex items-center gap-2">
                <div style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: ollamaOk ? '#3dffaa' : '#ff4d58',
                  boxShadow: ollamaOk ? '0 0 6px #3dffaa' : 'none',
                }} />
                <span className="font-mono text-xs" style={{ color: ollamaOk ? '#3dffaa' : '#ff4d58' }}>
                  {ollamaOk ? 'Ollama connecté' : 'Ollama déconnecté'}
                </span>
                <button type="button" onClick={() => fetchStatus(true)} className="ml-auto" style={{ color: '#3d3060' }} title="Rafraîchir">
                  <RefreshCw size={11} />
                </button>
              </div>

              {/* Strict local mode toggle — verrou global infranchissable */}
              <div
                className="flex items-center justify-between py-3 px-4 rounded"
                style={{
                  background: settings.strict_local_mode ? 'rgba(244,114,182,0.08)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${settings.strict_local_mode ? 'rgba(244,114,182,0.35)' : 'rgba(255,255,255,0.07)'}`,
                }}
              >
                <div>
                  <p className="font-grotesk font-semibold text-sm flex items-center gap-2" style={{ color: settings.strict_local_mode ? '#f472b6' : '#f0eaff' }}>
                    🔒 Mode strictement local
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    {settings.strict_local_mode
                      ? 'ACTIF — aucun appel cloud possible, veille désactivée'
                      : 'Verrouille tout le trafic en local — désactive la veille cloud'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleToggleStrictLocal}
                  style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative', flexShrink: 0,
                    background: settings.strict_local_mode ? 'rgba(244,114,182,0.4)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${settings.strict_local_mode ? 'rgba(244,114,182,0.6)' : 'rgba(255,255,255,0.12)'}`,
                    cursor: saving ? 'default' : 'pointer', transition: 'all 0.2s',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3,
                    left: settings.strict_local_mode ? 22 : 3,
                    width: 16, height: 16, borderRadius: '50%',
                    background: settings.strict_local_mode ? '#f472b6' : '#5a4a7a',
                    transition: 'all 0.2s',
                  }} />
                </button>
              </div>

              {/* Paying cloud APIs toggle — no silent paid fallback without explicit opt-in */}
              <div
                className="flex items-center justify-between py-3 px-4 rounded"
                style={{
                  background: settings.paying_apis_enabled ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${settings.paying_apis_enabled ? 'rgba(245,158,11,0.35)' : 'rgba(255,255,255,0.07)'}`,
                }}
              >
                <div>
                  <p className="font-grotesk font-semibold text-sm flex items-center gap-2" style={{ color: settings.paying_apis_enabled ? '#f59e0b' : '#f0eaff' }}>
                    💳 Fallback cloud payant (Claude / OpenAI)
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    {settings.paying_apis_enabled
                      ? 'AUTORISÉ — le routeur peut basculer vers une API payante en dernier recours'
                      : 'DÉSACTIVÉ par défaut — jamais de bascule payante silencieuse'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      const res = await cortexClient.updateRouterSettings({ paying_apis_enabled: !settings.paying_apis_enabled });
                      setSettings(res.settings);
                    } finally {
                      setSaving(false);
                    }
                  }}
                  style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative', flexShrink: 0,
                    background: settings.paying_apis_enabled ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${settings.paying_apis_enabled ? 'rgba(245,158,11,0.6)' : 'rgba(255,255,255,0.12)'}`,
                    cursor: saving ? 'default' : 'pointer', transition: 'all 0.2s',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3,
                    left: settings.paying_apis_enabled ? 22 : 3,
                    width: 16, height: 16, borderRadius: '50%',
                    background: settings.paying_apis_enabled ? '#f59e0b' : '#5a4a7a',
                    transition: 'all 0.2s',
                  }} />
                </button>
              </div>

              {/* Style examples toggle — utiliser mes exemples de style dans les résumés */}
              <div
                className="flex items-center justify-between py-3 px-4 rounded"
                style={{
                  background: styleExamplesEnabled ? 'rgba(94,231,255,0.06)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${styleExamplesEnabled ? 'rgba(94,231,255,0.3)' : 'rgba(255,255,255,0.07)'}`,
                }}
              >
                <div>
                  <p className="font-grotesk font-semibold text-sm" style={{ color: styleExamplesEnabled ? '#5ee7ff' : '#f0eaff' }}>
                    ✎ Utiliser mes exemples de style
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Réutilise le style (structure, ton, mise en forme) de tes neurones « Exemple de résumé » lors des résumés — capture, veille, vidéo longue
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleToggleStyleExamples}
                  style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative', flexShrink: 0,
                    background: styleExamplesEnabled ? 'rgba(94,231,255,0.3)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${styleExamplesEnabled ? 'rgba(94,231,255,0.5)' : 'rgba(255,255,255,0.12)'}`,
                    cursor: saving ? 'default' : 'pointer', transition: 'all 0.2s',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3,
                    left: styleExamplesEnabled ? 22 : 3,
                    width: 16, height: 16, borderRadius: '50%',
                    background: styleExamplesEnabled ? '#5ee7ff' : '#5a4a7a',
                    transition: 'all 0.2s',
                  }} />
                </button>
              </div>

              {/* Router toggle */}
              <div className="flex items-center justify-between py-3 px-4 rounded" style={{ background: 'rgba(61,255,170,0.04)', border: '1px solid rgba(61,255,170,0.1)' }}>
                <div>
                  <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                    Router automatique
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Sélectionne le meilleur LLM selon la complexité de chaque requête
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleToggleRouter}
                  style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative', flexShrink: 0,
                    background: settings.router_enabled ? 'rgba(61,255,170,0.3)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${settings.router_enabled ? 'rgba(61,255,170,0.5)' : 'rgba(255,255,255,0.12)'}`,
                    cursor: saving ? 'default' : 'pointer', transition: 'all 0.2s',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3,
                    left: settings.router_enabled ? 22 : 3,
                    width: 16, height: 16, borderRadius: '50%',
                    background: settings.router_enabled ? '#3dffaa' : '#5a4a7a',
                    transition: 'all 0.2s',
                  }} />
                </button>
              </div>

              {/* Fallback model (when router disabled) */}
              {!settings.router_enabled && (
                <div className="px-4 py-3 rounded" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <p className="font-mono text-xs mb-2" style={{ color: '#7a6c9a' }}>MODÈLE FIXE (router désactivé)</p>
                  <select
                    value={settings.fallback_model}
                    onChange={e => handleFallbackChange(e.target.value)}
                    className="font-mono text-xs w-full bg-transparent border-0 outline-none"
                    style={{ color: '#c0b0e0', cursor: 'pointer' }}
                  >
                    {Array.from(new Set([
                      settings.fallback_model,
                      ...OLLAMA_RECOMMENDED_MODELS.map(model => model.name),
                      ...installedOllamaModels.map(model => model.name),
                    ])).map(name => (
                      <option key={name} value={name} style={{ background: '#0f0b1e' }}>
                        {name}{installedModelNames.has(name) ? ' (installé)' : ''}
                      </option>
                    ))}
                    {installedOllamaModels.length === 0 && (
                      <option value="llama3.2:3b" style={{ background: '#0f0b1e' }}>llama3.2:3b</option>
                    )}
                  </select>
                </div>
              )}

              {/* Powerful mode model ("puissant [question]", CV, résumés) */}
              <div className="px-4 py-3 rounded" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="font-mono text-xs mb-1" style={{ color: '#7a6c9a' }}>MODÈLE "PUISSANT" (mode "puissant [question]", CV, résumés)</p>
                <select
                  value={settings.powerful_model ?? 'qwen2.5:14b-instruct-q3_K_M'}
                  onChange={e => handlePowerfulModelChange(e.target.value)}
                  className="font-mono text-xs w-full bg-transparent border-0 outline-none"
                  style={{ color: '#c0b0e0', cursor: 'pointer' }}
                >
                  {Array.from(new Set([
                    settings.powerful_model ?? 'qwen2.5:14b-instruct-q3_K_M',
                    ...installedOllamaModels.map(model => model.name),
                    'qwen2.5:14b', 'qwen2.5:14b-instruct-q3_K_M', 'mistral-nemo:12b-instruct-2407-q4_K_M',
                  ])).map(name => {
                    const installedEntry = installedOllamaModels.find(m => sameOllamaModelGroup(m.name, name));
                    const recommended    = OLLAMA_RECOMMENDED_MODELS.find(m => m.name === name);
                    const sizeBytes      = installedEntry?.size ?? recommended?.approxSizeBytes ?? null;
                    const fits           = sizeBytes !== null ? fitsVramBudget(sizeBytes) : true;
                    const sizeLabel      = sizeBytes !== null ? ` — ${formatBytes(sizeBytes)}${fits ? '' : ` (dépasse votre VRAM, plus lent)`}` : '';
                    return (
                      <option key={name} value={name} style={{ background: '#0f0b1e' }}>
                        {name}{installedModelNames.has(name) ? ' (installé)' : ' (non installé)'}{sizeLabel}
                      </option>
                    );
                  })}
                </select>
                <p className="font-mono text-[10px] mt-1" style={{ color: '#5a4a7a' }}>
                  Change immédiatement, sans relancer un prompt. Un modèle quantisé (q3_K_M, q4_K_M…) tient dans moins de VRAM que sa version complète.
                </p>
              </div>

              {/* Conversation mode model */}
              <div className="px-4 py-3 rounded" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="font-mono text-xs mb-1" style={{ color: '#7a6c9a' }}>MODÈLE DE CONVERSATION (mode Discussion)</p>
                <select
                  value={settings.chat_model ?? 'mistral-nemo:12b-instruct-2407-q4_K_M'}
                  onChange={e => handleChatModelChange(e.target.value)}
                  className="font-mono text-xs w-full bg-transparent border-0 outline-none"
                  style={{ color: '#c0b0e0', cursor: 'pointer' }}
                >
                  {Array.from(new Set([
                    settings.chat_model ?? 'mistral-nemo:12b-instruct-2407-q4_K_M',
                    ...installedOllamaModels.map(model => model.name),
                    'mistral-nemo:12b-instruct-2407-q4_K_M', 'qwen2.5:14b-instruct-q3_K_M',
                  ])).map(name => {
                    const installedEntry = installedOllamaModels.find(m => sameOllamaModelGroup(m.name, name));
                    const recommended    = OLLAMA_RECOMMENDED_MODELS.find(m => m.name === name);
                    const sizeBytes      = installedEntry?.size ?? recommended?.approxSizeBytes ?? null;
                    const fits           = sizeBytes !== null ? fitsVramBudget(sizeBytes) : true;
                    const sizeLabel      = sizeBytes !== null ? ` — ${formatBytes(sizeBytes)}${fits ? '' : ` (dépasse votre VRAM, plus lent)`}` : '';
                    return (
                      <option key={name} value={name} style={{ background: '#0f0b1e' }}>
                        {name}{installedModelNames.has(name) ? ' (installé)' : ' (non installé)'}{sizeLabel}
                      </option>
                    );
                  })}
                </select>
                <p className="font-mono text-[10px] mt-1" style={{ color: '#5a4a7a' }}>
                  Un modèle de conversation et qwen2.5:7b ne tiennent pas ensemble en VRAM — chargement géré comme le mode puissant.
                </p>
              </div>

              {/* Ollama model management */}
              <div className="px-4 py-3 rounded flex flex-col gap-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center gap-2">
                  <div style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: ollamaOk ? '#3dffaa' : '#ff4d58',
                    boxShadow: ollamaOk ? '0 0 6px #3dffaa' : 'none',
                  }} />
                  <span className="font-mono text-xs" style={{ color: ollamaOk ? '#3dffaa' : '#ff4d58' }}>
                    {ollamaOk ? 'Ollama connecté' : 'Ollama déconnecté'}
                  </span>
                  <button type="button" onClick={() => fetchStatus(true)} className="ml-auto" style={{ color: '#3d3060' }} title="Rafraîchir">
                    <RefreshCw size={11} />
                  </button>
                </div>

                {ollamaModels?.error && !ollamaModels.connected && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{ollamaModels.error}</p>}
                {modelMessage && <p className="font-mono text-xs" style={{ color: modelMessage.toLowerCase().includes('erreur') || modelMessage.toLowerCase().includes('refus') ? '#ff4d58' : '#3dffaa' }}>{modelMessage}</p>}

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded px-3 py-2" style={{ background: 'rgba(61,255,170,0.04)', border: '1px solid rgba(61,255,170,0.08)' }}>
                    <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Stockage utilisé</p>
                    <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{formatBytes(totalInstalledBytes)}</p>
                  </div>
                  <div className="rounded px-3 py-2" style={{ background: 'rgba(94,231,255,0.04)', border: '1px solid rgba(94,231,255,0.08)' }}>
                    <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Espace libre</p>
                    <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{formatBytes(freeBytes)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs px-2 py-1 rounded" style={{ background: 'rgba(61,255,170,0.08)', color: '#3dffaa', border: '1px solid rgba(61,255,170,0.18)' }}>
                    {installedOllamaModels.length} modèle{installedOllamaModels.length > 1 ? 's' : ''} installé{installedOllamaModels.length > 1 ? 's' : ''}
                  </span>
                  <span className="font-mono text-xs px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.03)', color: '#c0b0e0', border: '1px solid rgba(255,255,255,0.07)' }}>
                    {installedRecommendedModels.length} recommandé{installedRecommendedModels.length > 1 ? 's' : ''}
                  </span>
                  {freeBytes !== null && OLLAMA_RECOMMENDED_MODELS.some(model => !installedModelNames.has(model.name) && freeBytes < model.approxSizeBytes) && (
                    <span className="font-mono text-xs px-2 py-1 rounded" style={{ background: 'rgba(255,77,88,0.08)', color: '#ff4d58', border: '1px solid rgba(255,77,88,0.18)' }}>
                      Espace disque potentiellement insuffisant
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customModelName}
                    onChange={e => {
                      setCustomModelName(e.target.value);
                      setCustomModelError(null);
                    }}
                    placeholder="qwen2.5:7b"
                    aria-label="Nom de modèle Ollama"
                    className="font-mono flex-1"
                    style={{ fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, color: '#c0b0e0', padding: '6px 8px', minWidth: 0, outline: 'none' }}
                  />
                  <button
                    type="button"
                    disabled={!canManageModels || modelBusy !== null}
                    onClick={handleCustomModelInstall}
                    className="font-mono text-xs px-3 py-1.5 rounded flex items-center gap-1.5"
                    style={{
                      background: !canManageModels || modelBusy !== null ? 'rgba(255,255,255,0.04)' : 'rgba(61,255,170,0.12)',
                      border: `1px solid ${!canManageModels || modelBusy !== null ? 'rgba(255,255,255,0.08)' : 'rgba(61,255,170,0.28)'}`,
                      color: !canManageModels || modelBusy !== null ? '#5a4a7a' : '#3dffaa',
                      cursor: !canManageModels || modelBusy !== null ? 'default' : 'pointer',
                    }}
                  >
                    <Download size={10} />
                    Installer
                  </button>
                </div>

                {customModelError && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{customModelError}</p>}

                <div className="flex flex-col gap-2">
                  {OLLAMA_RECOMMENDED_MODELS.map((model) => {
                    const currentModel = installedOllamaModels.find((entry) => sameOllamaModelGroup(entry.name, model.name));
                    const installed = !!currentModel;
                    const protectedModel = ollamaModels?.guarded_models?.some((guarded) => sameOllamaModelGroup(guarded, currentModel?.name ?? model.name)) ?? false;
                    const estimatedLowDisk = freeBytes !== null && freeBytes < model.approxSizeBytes;
                    const vramWarn = model.approxVramGiB > 8;
                    return (
                      <div key={model.name} className="rounded px-3 py-3" style={{ background: installed ? 'rgba(61,255,170,0.04)' : 'rgba(255,255,255,0.02)', border: `1px solid ${installed ? 'rgba(61,255,170,0.12)' : 'rgba(255,255,255,0.06)'}` }}>
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{model.label}</p>
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: installed ? 'rgba(61,255,170,0.1)' : 'rgba(255,255,255,0.05)', color: installed ? '#3dffaa' : '#7a6c9a', border: `1px solid ${installed ? 'rgba(61,255,170,0.2)' : 'rgba(255,255,255,0.08)'}` }}>{installed ? 'installé' : 'non installé'}</span>
                              {vramWarn && <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.18)' }}>VRAM &gt; 8 Go</span>}
                            </div>
                            <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>{model.name}</p>
                            <p className="font-mono text-[10px] mt-1" style={{ color: '#5a4a7a' }}>{model.note}</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>{formatBytes(currentModel?.size ?? model.approxSizeBytes)}</p>
                            <p className="font-mono text-[10px]" style={{ color: vramWarn ? '#f59e0b' : '#3d3060' }}>VRAM ~ {formatGiB(model.approxVramGiB)}</p>
                          </div>
                        </div>

                        {modelProgress?.model === model.name && (
                          <div className="mt-2 flex flex-col gap-1">
                            <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${modelProgress.percent}%`, background: '#3dffaa', transition: 'width 0.2s' }} />
                            </div>
                            <p className="font-mono text-[10px]" style={{ color: '#3dffaa' }}>
                              {modelProgress.status} · {modelProgress.percent}%
                              {modelProgress.total ? ` · ${formatBytes(modelProgress.completed)} / ${formatBytes(modelProgress.total)}` : ''}
                            </p>
                            <button type="button" onClick={stopModelAction} className="font-mono text-[10px] px-2 py-1 rounded self-start" style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.18)', color: '#ff4d58' }}>
                              Annuler
                            </button>
                          </div>
                        )}

                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          {!installed ? (
                            <button
                              type="button"
                              disabled={!canManageModels || modelBusy !== null || estimatedLowDisk}
                              onClick={() => handleInstallModel(model.name)}
                              className="font-mono text-xs px-3 py-1.5 rounded flex items-center gap-1.5"
                              style={{
                                background: !canManageModels || modelBusy !== null || estimatedLowDisk ? 'rgba(255,255,255,0.04)' : 'rgba(61,255,170,0.12)',
                                border: `1px solid ${!canManageModels || modelBusy !== null || estimatedLowDisk ? 'rgba(255,255,255,0.08)' : 'rgba(61,255,170,0.28)'}`,
                                color: !canManageModels || modelBusy !== null || estimatedLowDisk ? '#5a4a7a' : '#3dffaa',
                                cursor: !canManageModels || modelBusy !== null || estimatedLowDisk ? 'default' : 'pointer',
                              }}
                            >
                              <Download size={10} />
                              Installer
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={!canManageModels || modelBusy !== null || protectedModel}
                              onClick={() => handleDeleteModel(currentModel?.name ?? model.name)}
                              className="font-mono text-xs px-3 py-1.5 rounded flex items-center gap-1.5"
                              style={{
                                background: 'rgba(255,77,88,0.08)',
                                border: '1px solid rgba(255,77,88,0.18)',
                                color: '#ff4d58',
                                cursor: !canManageModels || modelBusy !== null || protectedModel ? 'default' : 'pointer',
                                opacity: !canManageModels || modelBusy !== null || protectedModel ? 0.55 : 1,
                              }}
                            >
                              <Trash2 size={10} />
                              Désinstaller
                            </button>
                          )}

                          {protectedModel && <span className="font-mono text-[10px] px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', color: '#f59e0b' }}>Modèle protégé</span>}
                          {estimatedLowDisk && !installed && <span className="font-mono text-[10px] px-2 py-1 rounded" style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.18)', color: '#ff4d58' }}>Espace disque potentiellement insuffisant</span>}
                        </div>
                      </div>
                    );
                  })}

                  {extraInstalledModels.length > 0 && (
                    <div className="pt-1 flex flex-col gap-2">
                      <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>AUTRES MODÈLES INSTALLÉS</p>
                      {extraInstalledModels.map((model) => {
                        const protectedModel = ollamaModels?.guarded_models?.some((guarded) => sameOllamaModelGroup(guarded, model.name)) ?? false;
                        const fitsVram = fitsVramBudget(model.size);
                        return (
                          <div key={model.name} className="flex items-center gap-3 px-3 py-2.5 rounded" style={{ background: 'rgba(61,255,170,0.03)', border: '1px solid rgba(61,255,170,0.08)' }}>
                            <CheckCircle size={13} style={{ color: '#3dffaa', flexShrink: 0 }} />
                            <div className="flex-1 min-w-0">
                              <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>{model.name}</p>
                              <p className="font-mono" style={{ fontSize: 10, color: '#3d3060' }}>
                                {formatBytes(model.size)}
                                {' · '}
                                <span style={{ color: fitsVram ? '#3dffaa' : '#f59e0b' }}>{fitsVram ? `tient dans ${VRAM_BUDGET_GIB} Go` : `déborde de ${VRAM_BUDGET_GIB} Go`}</span>
                              </p>
                            </div>
                            {protectedModel && <span className="font-mono text-[10px] px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', color: '#f59e0b' }}>Protégé</span>}
                            <button type="button" disabled={!canManageModels || modelBusy !== null || protectedModel} onClick={() => handleDeleteModel(model.name)} className="font-mono text-xs px-3 py-1.5 rounded flex items-center gap-1.5" style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.18)', color: '#ff4d58', cursor: !canManageModels || modelBusy !== null || protectedModel ? 'default' : 'pointer', opacity: !canManageModels || modelBusy !== null || protectedModel ? 0.55 : 1 }}>
                              <Trash2 size={10} />
                              Désinstaller
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {OLLAMA_RECOMMENDED_MODELS.map((model) => (
                    <button key={model.name} type="button" disabled={!canManageModels || modelBusy !== null} onClick={() => setCustomModelName(model.name)} className="font-mono text-[10px] px-2.5 py-1.5 rounded" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#7a6c9a', cursor: !canManageModels || modelBusy !== null ? 'default' : 'pointer' }}>
                      {model.name}
                    </button>
                  ))}
                </div>
              </div>


              {/* Cloud preference selector */}
              <div className="flex flex-col gap-2">
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  DÉCISION AUTOMATIQUE LOCAL / CLOUD
                </p>
                <div style={{ display: 'flex', gap: 6 }}>
                  {([
                    { value: 'local',    label: 'Privilégier local',  desc: 'Cloud uniquement si contenu très long ou phrase explicite' },
                    { value: 'balanced', label: 'Équilibre',          desc: 'Cloud pour les analyses complexes et contenu long' },
                    { value: 'quality',  label: 'Privilégier qualité', desc: 'Cloud pour toutes les analyses complexes' },
                  ] as const).map(opt => {
                    const active = (settings.cloud_preference ?? 'local') === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        title={opt.desc}
                        onClick={async () => {
                          setSettings(s => ({ ...s, cloud_preference: opt.value }));
                          try { await cortexClient.updateRouterSettings({ cloud_preference: opt.value }); } catch { /* ignore */ }
                        }}
                        className="font-mono flex-1"
                        style={{
                          fontSize:    9,
                          padding:     '6px 8px',
                          borderRadius: 6,
                          border:      `1px solid ${active ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.07)'}`,
                          background:   active ? 'rgba(61,255,170,0.1)' : 'rgba(255,255,255,0.03)',
                          color:        active ? '#3dffaa' : '#5a4a7a',
                          cursor:       'pointer',
                          textAlign:    'center',
                          letterSpacing: '0.06em',
                          transition:   'all 0.13s',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="font-mono" style={{ fontSize: 9, color: '#2e2555' }}>
                  {settings.cloud_preference === 'quality'
                    ? 'Gemini pour toutes les analyses complexes et contenu long (> 8 000 car.)'
                    : settings.cloud_preference === 'balanced'
                    ? 'Gemini pour les analyses avec mots-clés complexes et contenu long (> 15 000 car.)'
                    : 'Gemini uniquement si contenu très long (> 25 000 car.) ou phrase explicite type "analyse approfondie"'}
                </p>
              </div>

              {/* Cloud providers (L4-L5) */}
              <div className="flex flex-col gap-2">
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  CLOUD L4-L5 — CLÉS API
                </p>
                {CLOUD_PROVIDERS.filter(p => {
                  if (p.id === 'claude-oauth' || p.id === 'codex') return false;
                  // Anthropic/OpenAI API fields only show when that family's
                  // mode is explicitly set to "api" — subscription mode
                  // (default) hides the API key field entirely, per spec.
                  if (p.id === 'anthropic') return (settings.claude_mode ?? 'subscription') === 'api';
                  if (p.id === 'openai')    return (settings.openai_mode ?? 'subscription') === 'api';
                  return true;
                }).map(prov => {
                  const activeKey = `${prov.id}_active` as keyof CloudKeysMasked;
                  const maskedKey = `${prov.id}_key`    as keyof CloudKeysMasked;
                  const isActive  = cloudKeys ? !!cloudKeys[activeKey] : false;
                  const masked    = cloudKeys ? (cloudKeys[maskedKey] as string | null) : null;
                  const draft     = keyDrafts[prov.id] ?? '';
                  const visible   = !!keyVisible[prov.id];
                  const testing   = !!keyTesting[prov.id];
                  const testResult= keyTestResult[prov.id] ?? null;
                  const overview  = providersOverview?.providers.find(p => p.id === prov.id) ?? null;

                  async function saveKey() {
                    if (!draft) return;
                    try {
                      const r = await cortexClient.setCloudKey(prov.id, draft);
                      setCloudKeys(r.masked);
                      setKeyDrafts(d => ({ ...d, [prov.id]: '' }));
                      setKeyTestResult(r2 => ({ ...r2, [prov.id]: null }));
                    } catch (e) {
                      setKeyTestResult(r2 => ({ ...r2, [prov.id]: { ok: false, msg: (e as Error).message } }));
                    }
                  }

                  async function removeKey() {
                    try {
                      const r = await cortexClient.setCloudKey(prov.id, '');
                      setCloudKeys(r.masked);
                      setKeyDrafts(d => ({ ...d, [prov.id]: '' }));
                      setKeyTestResult(r2 => ({ ...r2, [prov.id]: null }));
                    } catch { /* ignore */ }
                  }

                  async function testKey() {
                    setKeyTesting(t => ({ ...t, [prov.id]: true }));
                    setKeyTestResult(r => ({ ...r, [prov.id]: null }));
                    try {
                      const r = await cortexClient.testCloudKey(prov.id, draft || undefined);
                      setKeyTestResult(res => ({ ...res, [prov.id]: { ok: r.ok, msg: r.ok ? `OK — ${r.model ?? prov.id}` : (r.error ?? 'Échec') } }));
                      cortexClient.getProvidersOverview().then(setProvidersOverview).catch(() => {});
                    } catch (e) {
                      setKeyTestResult(res => ({ ...res, [prov.id]: { ok: false, msg: (e as Error).message } }));
                    } finally {
                      setKeyTesting(t => ({ ...t, [prov.id]: false }));
                    }
                  }

                  return (
                    <div
                      key={prov.id}
                      className="px-3 py-3 rounded flex flex-col gap-2"
                      style={{
                        background: isActive ? `${prov.color}08` : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${isActive ? `${prov.color}28` : 'rgba(255,255,255,0.06)'}`,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>
                          {prov.label}
                        </span>
                        <span className="font-mono px-1.5 py-0.5 rounded" style={{
                          fontSize: 9, letterSpacing: '0.08em',
                          background: prov.free ? 'rgba(61,255,170,0.1)' : 'rgba(245,158,11,0.1)',
                          color: prov.free ? '#3dffaa' : '#f59e0b',
                          border: `1px solid ${prov.free ? 'rgba(61,255,170,0.2)' : 'rgba(245,158,11,0.2)'}`,
                        }}>
                          {prov.free ? 'GRATUIT' : 'PAYANT'}
                        </span>
                        <span className="font-mono px-1.5 py-0.5 rounded" style={{
                          fontSize: 9, letterSpacing: '0.08em',
                          background: isActive ? `${prov.color}18` : 'rgba(255,255,255,0.05)',
                          color: isActive ? prov.color : '#3d3060',
                          border: `1px solid ${isActive ? `${prov.color}40` : 'rgba(255,255,255,0.08)'}`,
                        }}>
                          {isActive ? 'ACTIF' : 'NON CONFIGURÉ'}
                        </span>
                        {isActive && overview && (
                          <span
                            className="font-mono px-1.5 py-0.5 rounded flex items-center gap-1"
                            style={{
                              fontSize: 9, letterSpacing: '0.06em',
                              background: `${PROVIDER_STATE_COLORS[overview.status]}14`,
                              color: PROVIDER_STATE_COLORS[overview.status],
                              border: `1px solid ${PROVIDER_STATE_COLORS[overview.status]}40`,
                            }}
                            title={overview.in_cooldown ? `Réessai auto dans ${formatCooldown(overview.cooldown_remaining_ms)}` : undefined}
                          >
                            {overview.status === 'ready' ? <CheckCircle size={9} /> : <AlertTriangle size={9} />}
                            {PROVIDER_STATE_LABELS[overview.status]}
                            {overview.in_cooldown && ` (${formatCooldown(overview.cooldown_remaining_ms)})`}
                          </span>
                        )}
                      </div>

                      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>{prov.note}</p>
                      {prov.id === 'freellmapi' && (
                        <div className="flex flex-col gap-2 mt-1">
                          <label className="flex items-center gap-2 font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
                            <input
                              type="checkbox"
                              checked={settings.freellmapi?.enabled ?? false}
                              onChange={async e => {
                                const freellmapi = { ...settings.freellmapi!, enabled: e.target.checked };
                                setSettings(s => ({ ...s, freellmapi }));
                                await cortexClient.updateRouterSettings({ freellmapi });
                              }}
                            />
                            Activer FreeLLMAPI
                          </label>
                          <input
                            type="url"
                            value={settings.freellmapi?.baseUrl ?? ''}
                            onChange={e => setSettings(s => ({ ...s, freellmapi: { ...s.freellmapi!, baseUrl: e.target.value } }))}
                            onBlur={async e => {
                              const freellmapi = { ...settings.freellmapi!, baseUrl: e.target.value.trim().replace(/\/$/, '') };
                              setSettings(s => ({ ...s, freellmapi }));
                              await cortexClient.updateRouterSettings({ freellmapi });
                            }}
                            placeholder="https://gateway.example/v1 (sans /v1 si nécessaire)"
                            aria-label="Endpoint FreeLLMAPI"
                            className="font-mono w-full"
                            style={{ fontSize: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, color: '#c0b0e0', padding: '4px 8px', outline: 'none' }}
                          />
                          <label className="flex items-center gap-2 font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
                            <input
                              type="checkbox"
                              checked={settings.freellmapi?.freeOnly ?? false}
                              onChange={async e => {
                                const freellmapi = { ...settings.freellmapi!, freeOnly: e.target.checked };
                                setSettings(s => ({ ...s, freellmapi }));
                                await cortexClient.updateRouterSettings({ freellmapi });
                              }}
                            />
                            Free only (si l API le prouve)
                          </label>
                          <label className="flex items-center gap-2 font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
                            <input type="checkbox" checked={settings.freellmapi?.allowFallback ?? true} onChange={async e => {
                              const freellmapi = { ...settings.freellmapi!, allowFallback: e.target.checked };
                              setSettings(s => ({ ...s, freellmapi }));
                              await cortexClient.updateRouterSettings({ freellmapi });
                            }} />
                            Autoriser le fallback
                          </label>
                          <div className="flex items-center gap-2">
                            <span className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>Mode :</span>
                            {(['auto', 'manual'] as const).map(mode => (
                              <button key={mode} type="button" onClick={async () => {
                                const freellmapi = { ...settings.freellmapi!, mode };
                                setSettings(s => ({ ...s, freellmapi }));
                                await cortexClient.updateRouterSettings({ freellmapi });
                              }} className="font-mono px-2 py-1 rounded" style={{ fontSize: 9, color: settings.freellmapi?.mode === mode ? '#22d3ee' : '#5a4a7a', border: `1px solid ${settings.freellmapi?.mode === mode ? 'rgba(34,211,238,0.4)' : 'rgba(255,255,255,0.08)'}`, background: 'rgba(255,255,255,0.03)' }}>{mode}</button>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-3 font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>
                            <label className="flex items-center gap-1"><input type="checkbox" checked={settings.freellmapi?.allowText ?? true} onChange={async e => { const freellmapi = { ...settings.freellmapi!, allowText: e.target.checked }; setSettings(s => ({ ...s, freellmapi })); await cortexClient.updateRouterSettings({ freellmapi }); }} /> Texte</label>
                            {(['Image', 'Video', 'Audio'] as const).map(modality => <label key={modality} className="flex items-center gap-1" title="NON SUPPORTÉ : aucune capacité annoncée par FreeLLMAPI"><input type="checkbox" disabled checked={false} readOnly /> {modality}</label>)}
                          </div>
                          {settings.freellmapi?.mode === 'manual' && <input type="text" value={settings.freellmapi?.textModel ?? 'auto'} onChange={e => setSettings(s => ({ ...s, freellmapi: { ...s.freellmapi!, textModel: e.target.value } }))} onBlur={async e => { const freellmapi = { ...settings.freellmapi!, textModel: e.target.value.trim() || 'auto' }; setSettings(s => ({ ...s, freellmapi })); await cortexClient.updateRouterSettings({ freellmapi }); }} placeholder="Modèle texte" aria-label="Modèle texte FreeLLMAPI" className="font-mono w-full" style={{ fontSize: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: '#c0b0e0', padding: '4px 8px', outline: 'none' }} />}
                          {freeModels.length > 0 && <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>Modèles : {freeModels.map(model => `${model.id}${model.free === true ? ' (free)' : ''}`).join(', ')}</p>}
                        </div>
                      )}
                      {overview?.default_model && (
                        <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
                          Modèle par défaut : {overview.default_model}
                        </p>
                      )}

                      {prov.id === 'groq' && (
                        <div className="flex items-center gap-2 mt-1">
                          <span className="font-mono flex-shrink-0" style={{ fontSize: 10, color: '#5a4a7a' }}>Modèle :</span>
                          <input
                            type="text"
                            value={settings.groq_model ?? 'openai/gpt-oss-120b'}
                            onChange={async e => {
                              const v = e.target.value;
                              setSettings(s => ({ ...s, groq_model: v }));
                              await cortexClient.updateRouterSettings({ groq_model: v });
                            }}
                            className="font-mono flex-1"
                            style={{
                              fontSize: 10, background: 'rgba(255,255,255,0.04)',
                              border: '1px solid rgba(255,255,255,0.10)',
                              borderRadius: 4, color: '#c0b0e0', padding: '3px 6px',
                              outline: 'none',
                            }}
                            placeholder="openai/gpt-oss-120b"
                          />
                        </div>
                      )}

                      {/* Key input row */}
                      <div className="flex items-center gap-2">
                        <div className="flex-1 relative">
                          <input
                            type={visible ? 'text' : 'password'}
                            value={draft}
                            onChange={e => {
                              setKeyDrafts(d => ({ ...d, [prov.id]: e.target.value }));
                              setKeyTestResult(r => ({ ...r, [prov.id]: null }));
                            }}
                            placeholder={masked ?? `Clé ${prov.label}`}
                            aria-label={`Clé API ${prov.label}`}
                            className="font-mono w-full"
                            style={{
                              fontSize: 11, background: 'rgba(255,255,255,0.04)',
                              border: '1px solid rgba(255,255,255,0.10)',
                              borderRadius: 4, color: '#c0b0e0', padding: '4px 28px 4px 8px',
                              outline: 'none',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setKeyVisible(v => ({ ...v, [prov.id]: !visible }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2"
                            style={{ color: '#3d3060' }}
                            title={visible ? 'Masquer' : 'Afficher'}
                          >
                            {visible ? <EyeOff size={11} /> : <Eye size={11} />}
                          </button>
                        </div>

                        {/* Test button */}
                        <button
                          type="button"
                          disabled={testing || (!draft && !isActive)}
                          onClick={testKey}
                          className="font-mono text-xs px-2.5 py-1.5 rounded flex items-center gap-1.5 flex-shrink-0"
                          style={{
                            background: 'rgba(94,231,255,0.08)',
                            border: '1px solid rgba(94,231,255,0.2)',
                            color: testing ? '#3d3060' : '#5ee7ff',
                            cursor: testing ? 'default' : 'pointer',
                          }}
                        >
                          {testing ? <RefreshCw size={10} className="animate-spin" /> : <Zap size={10} />}
                          Tester
                        </button>

                        {prov.id === 'freellmapi' && (
                          <button type="button" disabled={testing || !isActive} onClick={async () => {
                            try {
                              const result = await cortexClient.getFreeLLMAPIModels(true);
                              setFreeModels(result.models);
                              setKeyTestResult(r => ({ ...r, freellmapi: { ok: !result.error, msg: result.error ?? `${result.models.length} modèle(s) découvert(s)` } }));
                            } catch (e) {
                              setKeyTestResult(r => ({ ...r, freellmapi: { ok: false, msg: (e as Error).message } }));
                            }
                          }} className="font-mono text-xs px-2.5 py-1.5 rounded flex-shrink-0" style={{ background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.2)', color: '#22d3ee', cursor: 'pointer' }}>
                            Modèles
                          </button>
                        )}

                        {/* Save */}
                        {draft && (
                          <button
                            type="button"
                            onClick={saveKey}
                            className="font-mono text-xs px-2.5 py-1.5 rounded flex-shrink-0"
                            style={{
                              background: `${prov.color}14`,
                              border: `1px solid ${prov.color}40`,
                              color: prov.color,
                              cursor: 'pointer',
                            }}
                          >
                            Sauver
                          </button>
                        )}

                        {/* Remove */}
                        {isActive && !draft && (
                          <button
                            type="button"
                            onClick={removeKey}
                            className="font-mono text-xs px-2.5 py-1.5 rounded flex-shrink-0"
                            style={{
                              background: 'rgba(255,77,88,0.08)',
                              border: '1px solid rgba(255,77,88,0.2)',
                              color: '#ff4d58',
                              cursor: 'pointer',
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>

                      {/* Test result */}
                      {testResult && (
                        <p className="font-mono" style={{ fontSize: 10, color: testResult.ok ? '#3dffaa' : '#ff4d58' }}>
                          {testResult.ok ? '✓' : '✗'} {testResult.msg}
                        </p>
                      )}

                      {/* RPM limiter — Gemini only */}
                      {prov.id === 'gemini' && (
                        <div className="flex items-center gap-3 pt-1">
                          <p className="font-mono flex-1" style={{ fontSize: 10, color: '#5a4a7a' }}>
                            Limite req/min ({geminiRpm} RPM)
                          </p>
                          <input
                            type="range"
                            min={1} max={30} step={1}
                            value={geminiRpm}
                            onChange={async e => {
                              const n = Number(e.target.value);
                              setGeminiRpm(n);
                              try { await cortexClient.setGeminiRpm(n); } catch { /* ignore */ }
                            }}
                            title={`${geminiRpm} requêtes/min`}
                            style={{ width: 80, accentColor: '#5ee7ff', cursor: 'pointer' }}
                          />
                          <span className="font-mono" style={{ fontSize: 10, color: '#5ee7ff', minWidth: 24, textAlign: 'right' }}>
                            {geminiRpm}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <FreeAiFinder strictLocalActive={settings.strict_local_mode === true} />

              {/* Claude / OpenAI — mode selector (abonnement CLI vs clé API) */}
              <div className="flex flex-col gap-2">
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  CLAUDE — CHOIX DU BACKEND
                </p>
                <div className="flex gap-2">
                  {(['subscription', 'api'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleSetClaudeMode(m)}
                      className="font-mono text-xs px-2.5 py-1.5 rounded flex-1"
                      style={{
                        background: (settings.claude_mode ?? 'subscription') === m ? 'rgba(139,92,246,0.12)' : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${(settings.claude_mode ?? 'subscription') === m ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.06)'}`,
                        color: (settings.claude_mode ?? 'subscription') === m ? '#a78bfa' : '#7a6c9a',
                        cursor: 'pointer',
                      }}
                    >
                      {m === 'subscription' ? 'Claude Code / abonnement' : 'API Anthropic'}
                    </button>
                  ))}
                </div>
              </div>

              {/* OpenAI — mode selector (Codex/ChatGPT vs clé API) */}
              <div className="flex flex-col gap-2">
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  OPENAI — CHOIX DU BACKEND
                </p>
                <div className="flex gap-2">
                  {(['subscription', 'api'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleSetOpenaiMode(m)}
                      className="font-mono text-xs px-2.5 py-1.5 rounded flex-1"
                      style={{
                        background: (settings.openai_mode ?? 'subscription') === m ? 'rgba(14,165,233,0.12)' : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${(settings.openai_mode ?? 'subscription') === m ? 'rgba(14,165,233,0.4)' : 'rgba(255,255,255,0.06)'}`,
                        color: (settings.openai_mode ?? 'subscription') === m ? '#0ea5e9' : '#7a6c9a',
                        cursor: 'pointer',
                      }}
                    >
                      {m === 'subscription' ? 'Codex / compte ChatGPT' : 'API OpenAI'}
                    </button>
                  ))}
                </div>
              </div>

              {/* OAuth providers (separate section) */}
              <div className="flex flex-col gap-2">
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  CLOUD L5 — AUTHENTIFICATION OAUTH
                </p>
                <p className="font-mono text-xs" style={{ color: '#7a6c9a', fontSize: 10 }}>
                  Ces providers utilisent leur propre CLI pour la connexion.
                  Aucun token n'est stocké dans Docteur.
                </p>
                {(['claude-oauth', 'codex'] as const).filter(provId => {
                  if (provId === 'claude-oauth') return (settings.claude_mode ?? 'subscription') === 'subscription';
                  if (provId === 'codex')        return (settings.openai_mode ?? 'subscription') === 'subscription';
                  return true;
                }).map(provId => {
                  const prov = CLOUD_PROVIDERS.find(p => p.id === provId);
                  if (!prov) return null;
                  
                  const overview = providersOverview?.providers.find(p => p.id === provId);
                  const testing = !!keyTesting[provId];
                  const testResult = keyTestResult[provId] ?? null;

                  async function testProvider() {
                    setKeyTesting(t => ({ ...t, [provId]: true }));
                    setKeyTestResult(r => ({ ...r, [provId]: null }));
                    try {
                      const r = await cortexClient.testCloudKey(provId);
                      const authModeLabel = r.authMode === 'setup_token' ? ' (setup-token)' : r.authMode === 'cli_session' ? ' (session CLI)' : '';
                      setKeyTestResult(res => ({ ...res, [provId]: { ok: r.ok, msg: r.ok ? `OK — ${r.model ?? provId}${authModeLabel}` : (r.error ?? 'Échec') } }));
                      cortexClient.getProvidersOverview().then(setProvidersOverview).catch(() => {});
                    } catch (e) {
                      setKeyTestResult(res => ({ ...res, [provId]: { ok: false, msg: (e as Error).message } }));
                    } finally {
                      setKeyTesting(t => ({ ...t, [provId]: false }));
                    }
                  }

                  return (
                    <div
                      key={provId}
                      className="px-3 py-3 rounded flex flex-col gap-2"
                      style={{
                        background: overview?.enabled ? `${prov.color}08` : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${overview?.enabled ? `${prov.color}28` : 'rgba(255,255,255,0.06)'}`,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>
                          {prov.label}
                        </span>
                        <span className="font-mono px-1.5 py-0.5 rounded" style={{
                          fontSize: 9, letterSpacing: '0.08em',
                          background: 'rgba(61,255,170,0.1)',
                          color: '#3dffaa',
                          border: '1px solid rgba(61,255,170,0.2)',
                        }}>
                          ABONNEMENT
                        </span>
                        {overview && (
                          <span
                            className="font-mono px-1.5 py-0.5 rounded flex items-center gap-1"
                            style={{
                              fontSize: 9, letterSpacing: '0.06em',
                              background: `${PROVIDER_STATE_COLORS[overview.status]}14`,
                              color: PROVIDER_STATE_COLORS[overview.status],
                              border: `1px solid ${PROVIDER_STATE_COLORS[overview.status]}40`,
                            }}
                            title={overview.in_cooldown ? `Réessai auto dans ${formatCooldown(overview.cooldown_remaining_ms)}` : undefined}
                          >
                            {overview.status === 'ready' ? <CheckCircle size={9} /> : <AlertTriangle size={9} />}
                            {PROVIDER_STATE_LABELS[overview.status]}
                            {overview.in_cooldown && ` (${formatCooldown(overview.cooldown_remaining_ms)})`}
                          </span>
                        )}
                      </div>

                      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>{prov.note}</p>
                      {overview?.default_model && (
                        <p className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
                          Modèle par défaut : {overview.default_model}
                        </p>
                      )}

                      <div className="flex items-center gap-3">
                        <span className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
                          CLI installée : {overview?.cli_installed ? 'oui' : 'non'}
                        </span>
                        <span className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
                          Connecté : {overview?.configured ? 'oui' : 'non'}
                        </span>
                        {provId === 'claude-oauth' && overview?.configured && (
                          <span className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
                            Auth : {overview?.authMode === 'setup_token' ? 'setup-token' : 'session CLI'}
                          </span>
                        )}
                      </div>

                      {!overview?.cli_installed ? (
                        <p className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
                          {provId === 'claude-oauth' ? "Claude Code n'est pas installé." : "Codex n'est pas installé."}
                          <br />
                          Exécutez <code style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 3px', borderRadius: 2 }}>
                            {provId === 'claude-oauth' ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @openai/codex'}
                          </code>
                          {provId === 'claude-oauth'
                            ? ', puis lancez Claude Code et suivez le login officiel.'
                            : ', puis lancez '}
                          {provId === 'codex' && (
                            <code style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 3px', borderRadius: 2 }}>codex</code>
                          )}
                          {provId === 'codex' && ' et suivez la connexion avec ChatGPT.'}
                        </p>
                      ) : !overview?.configured ? (
                        <p className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
                          Exécutez <code style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 3px', borderRadius: 2 }}>
                            {provId === 'claude-oauth' ? 'claude auth login' : 'codex login'}
                          </code>{provId === 'claude-oauth' ? ' (ou définissez CLAUDE_CODE_OAUTH_TOKEN)' : ''} dans votre terminal, puis cliquez sur Tester.
                        </p>
                      ) : null}

                      <div className="flex items-center gap-2 mt-1">
                        <button
                          type="button"
                          disabled={testing}
                          onClick={testProvider}
                          className="font-mono text-xs px-2.5 py-1.5 rounded flex items-center gap-1.5 flex-1 justify-center"
                          style={{
                            background: 'rgba(94,231,255,0.08)',
                            border: '1px solid rgba(94,231,255,0.2)',
                            color: testing ? '#3d3060' : '#5ee7ff',
                            cursor: testing ? 'default' : 'pointer',
                          }}
                        >
                          {testing ? <RefreshCw size={10} className="animate-spin" /> : <Zap size={10} />}
                          Tester la connexion
                        </button>
                      </div>

                      {testResult && (
                        <p className="font-mono" style={{ fontSize: 10, color: testResult.ok ? '#3dffaa' : '#ff4d58' }}>
                          {testResult.ok ? '✓' : '✗'} {testResult.msg}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Local providers (Ollama + PAIR) */}
              <div className="flex flex-col gap-2">
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  LOCAL — INFÉRENCE LOCALE
                </p>
                
                {/* Ollama */}
                <div className="px-3 py-3 rounded flex flex-col gap-2"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>
                      Ollama
                    </span>
                    <span className="font-mono px-1.5 py-0.5 rounded" style={{
                      fontSize: 9, letterSpacing: '0.08em',
                      background: 'rgba(61,255,170,0.1)',
                      color: '#3dffaa',
                      border: '1px solid rgba(61,255,170,0.2)',
                    }}>
                      GRATUIT
                    </span>
                    <span className="font-mono px-1.5 py-0.5 rounded" style={{
                      fontSize: 9, letterSpacing: '0.08em',
                      background: ollamaOk ? 'rgba(61,255,170,0.18)' : 'rgba(255,255,255,0.05)',
                      color: ollamaOk ? '#3dffaa' : '#3d3060',
                      border: `1px solid ${ollamaOk ? 'rgba(61,255,170,0.40)' : 'rgba(255,255,255,0.08)'}`,
                    }}>
                      {ollamaOk ? 'CONNECTÉ' : 'DÉCONNECTÉ'}
                    </span>
                    <span className="font-mono px-1.5 py-0.5 rounded flex items-center gap-1" style={{
                      fontSize: 9, letterSpacing: '0.06em',
                      background: '#3dffaa14',
                      color: '#3dffaa',
                      border: '1px solid #3dffaa40',
                    }}>
                      <CheckCircle size={9} />
                      {installedOllamaModels.length} modèles
                    </span>
                  </div>
                  
                  <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>
                   Serveur local d'inférence — Modèles téléchargés sur votre machine.
                  </p>
                </div>

                {/* PAIR */}
                {providersOverview?.providers.find(p => p.id === 'pair') && (
                  <div className="px-3 py-3 rounded flex flex-col gap-2"
                    style={{
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>
                        NVIDIA PAIR
                      </span>
                      <span className="font-mono px-1.5 py-0.5 rounded" style={{
                        fontSize: 9, letterSpacing: '0.08em',
                        background: 'rgba(61,255,170,0.1)',
                        color: '#3dffaa',
                        border: '1px solid rgba(61,255,170,0.2)',
                      }}>
                        GRATUIT
                      </span>
                      {(() => {
                        const pairOverview = providersOverview?.providers.find(p => p.id === 'pair');
                        return pairOverview ? (
                          <span className="font-mono px-1.5 py-0.5 rounded flex items-center gap-1" style={{
                            fontSize: 9, letterSpacing: '0.06em',
                            background: `${PROVIDER_STATE_COLORS[pairOverview.status]}14`,
                            color: PROVIDER_STATE_COLORS[pairOverview.status],
                            border: `1px solid ${PROVIDER_STATE_COLORS[pairOverview.status]}40`,
                          }}>
                            {pairOverview.status === 'ready' ? <CheckCircle size={9} /> : <AlertTriangle size={9} />}
                            {PROVIDER_STATE_LABELS[pairOverview.status]}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    
                    <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>
                      Service d'inférence distribuée NVIDIA — Endpoint configurable.
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono flex-shrink-0" style={{ fontSize: 10, color: '#5a4a7a' }}>
                        Endpoint :
                      </span>
                      <input
                        type="text"
                        value={providersOverview?.providers.find(p => p.id === 'pair')?.endpoint ?? 'http://localhost:8080'}
                        onChange={async e => {
                          const endpoint = e.target.value;
                          try {
                            await cortexClient.setPairEndpoint(endpoint);
                            cortexClient.getProvidersOverview().then(setProvidersOverview).catch(() => {});
                          } catch (error) {
                            console.error('Erreur sauvegarde endpoint PAIR:', error);
                          }
                        }}
                        className="font-mono flex-1"
                        style={{
                          fontSize: 10, background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.10)',
                          borderRadius: 4, color: '#c0b0e0', padding: '3px 6px',
                          outline: 'none',
                        }}
                        placeholder="http://localhost:8080"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await cortexClient.testPairConnection();
                            cortexClient.getProvidersOverview().then(setProvidersOverview).catch(() => {});
                          } catch (error) {
                            console.error('Erreur test PAIR:', error);
                          }
                        }}
                        className="font-mono text-xs px-2.5 py-1.5 rounded flex items-center gap-1.5 flex-shrink-0"
                        style={{
                          background: 'rgba(94,231,255,0.08)',
                          border: '1px solid rgba(94,231,255,0.2)',
                          color: '#5ee7ff',
                          cursor: 'pointer',
                        }}
                      >
                        <Zap size={10} />
                        Tester
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Batch settings */}
              <div className="px-4 py-3 rounded flex flex-col gap-3"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                  TRAITEMENT PAR LOTS
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                      Taille de lot
                    </p>
                    <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                      Neurones traités avant chaque pause ({batchSize} actuel)
                    </p>
                  </div>
                  <input
                    type="range"
                    min={1} max={10} step={1}
                    value={batchSize}
                    onChange={e => onBatchSizeChange?.(Number(e.target.value))}
                    title={`Taille de lot : ${batchSize}`}
                    style={{ width: 100, accentColor: '#3dffaa', cursor: 'pointer' }}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                      Délai entre lots
                    </p>
                    <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                      Pause pour laisser Ollama respirer ({(batchDelay / 1000).toFixed(1)}s)
                    </p>
                  </div>
                  <input
                    type="range"
                    min={500} max={5000} step={500}
                    value={batchDelay}
                    onChange={e => onBatchDelayChange?.(Number(e.target.value))}
                    title={`Délai entre lots : ${batchDelay}ms`}
                    style={{ width: 100, accentColor: '#5ee7ff', cursor: 'pointer' }}
                  />
                </div>
              </div>

              {/* Download folder */}
              <div className="px-4 py-3 rounded flex items-center justify-between gap-4"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="min-w-0 flex-1">
                  <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                    Dossier de téléchargement vidéos
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Dossier cible pour yt-dlp (download …)
                  </p>
                </div>
                <input
                  type="text"
                  value={downloadFolder}
                  onChange={e => onDownloadFolderChange?.(e.target.value)}
                  placeholder="D:\upload"
                  title="Dossier de téléchargement"
                  aria-label="Dossier de téléchargement vidéos"
                  className="font-mono"
                  style={{
                    fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: 4, color: '#c0b0e0', padding: '4px 8px', width: 180, minWidth: 0,
                    outline: 'none',
                  }}
                />
              </div>

              {/* Merge duplicate parents */}
              {onMergeDuplicates && (
                <div className="px-4 py-3 rounded flex items-center justify-between gap-4"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="min-w-0">
                    <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                      Fusionner les sources dupliquées
                    </p>
                    <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                      {mergeResult ?? 'Regroupe les neurones « channel » de même nom en un seul parent'}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={merging}
                    onClick={async () => {
                      setMerging(true);
                      setMergeResult(null);
                      try {
                        const n = await onMergeDuplicates();
                        setMergeResult(n === 0 ? 'Aucun doublon détecté' : `${n} doublon${n > 1 ? 's' : ''} fusionné${n > 1 ? 's' : ''}`);
                      } finally {
                        setMerging(false);
                      }
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs flex-shrink-0"
                    style={{
                      background:  merging ? 'rgba(255,255,255,0.04)' : 'rgba(167,139,250,0.12)',
                      border:      `1px solid ${merging ? 'rgba(255,255,255,0.08)' : 'rgba(167,139,250,0.3)'}`,
                      color:       merging ? '#5a4a7a' : '#a78bfa',
                      cursor:      merging ? 'default' : 'pointer',
                    }}
                  >
                    <Merge size={11} />
                    {merging ? 'Fusion…' : 'Fusionner'}
                  </button>
                </div>
              )}

              {/* Export IndexedDB → server */}
              <div className="px-4 py-3 rounded flex flex-col gap-2"
                style={{ background: 'rgba(61,255,170,0.03)', border: '1px solid rgba(61,255,170,0.1)' }}>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                      Exporter vers le serveur
                    </p>
                    <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                      {syncResult ?? 'Pousse tous les neurones locaux vers le serveur pour les accès mobiles'}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={async () => {
                      setSyncing(true);
                      setSyncDone(0);
                      setSyncTotal(0);
                      setSyncResult(null);
                      try {
                        const n = await exportAllToServer((done, total) => {
                          setSyncDone(done);
                          setSyncTotal(total);
                        });
                        setSyncResult(`${n} neurone${n > 1 ? 's' : ''} synchronisé${n > 1 ? 's' : ''}`);
                      } catch (e) {
                        setSyncResult(`Erreur : ${(e as Error).message}`);
                      } finally {
                        setSyncing(false);
                      }
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs flex-shrink-0"
                    style={{
                      background: syncing ? 'rgba(255,255,255,0.04)' : 'rgba(61,255,170,0.12)',
                      border:     `1px solid ${syncing ? 'rgba(255,255,255,0.08)' : 'rgba(61,255,170,0.3)'}`,
                      color:      syncing ? '#5a4a7a' : '#3dffaa',
                      cursor:     syncing ? 'default' : 'pointer',
                    }}
                  >
                    {syncing
                      ? <RefreshCw size={11} className="animate-spin" />
                      : <Upload size={11} />}
                    {syncing ? 'Export…' : 'Exporter'}
                  </button>
                </div>

                {/* Progress bar */}
                {syncing && syncTotal > 0 && (
                  <div className="flex flex-col gap-1">
                    <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2, background: '#3dffaa',
                        width: `${Math.round((syncDone / syncTotal) * 100)}%`,
                        transition: 'width 0.2s',
                      }} />
                    </div>
                    <p className="font-mono" style={{ fontSize: 10, color: '#3dffaa' }}>
                      Synchronisation : {syncDone} / {syncTotal}
                    </p>
                  </div>
                )}
              </div>

              {/* Repair links — rebuild channel/playlist→video synapses from metadata */}
              <div className="px-4 py-3 rounded flex items-center justify-between gap-4"
                style={{ background: 'rgba(251,191,36,0.03)', border: '1px solid rgba(251,191,36,0.12)' }}>
                <div className="min-w-0">
                  <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                    Réparer les synapses
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    {repairResult ?? 'Reconstruit les liens chaîne↔vidéo et playlist↔vidéo à partir des métadonnées'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={repairing}
                  onClick={async () => {
                    setRepairing(true);
                    setRepairResult(null);
                    try {
                      const r = await cortexClient.repairLinks();
                      const total = r.channelLinksRepaired + r.playlistLinksRepaired;
                      setRepairResult(total === 0
                        ? 'Aucun lien manquant détecté'
                        : `${r.channelLinksRepaired} lien(s) chaîne, ${r.playlistLinksRepaired} lien(s) playlist réparés`);
                      if (total > 0) await onRepairDone?.();
                    } catch (e) {
                      setRepairResult(`Erreur : ${(e as Error).message}`);
                    } finally {
                      setRepairing(false);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs flex-shrink-0"
                  style={{
                    background: repairing ? 'rgba(255,255,255,0.04)' : 'rgba(251,191,36,0.12)',
                    border:     `1px solid ${repairing ? 'rgba(255,255,255,0.08)' : 'rgba(251,191,36,0.3)'}`,
                    color:      repairing ? '#5a4a7a' : '#fbbf24',
                    cursor:     repairing ? 'default' : 'pointer',
                  }}
                >
                  <Link2 size={11} />
                  {repairing ? 'Réparation…' : 'Réparer'}
                </button>
              </div>

              {/* Home screen toggle */}
              <div className="px-4 py-3 rounded flex items-center justify-between gap-4"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="min-w-0">
                  <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                    Écran d'accueil au démarrage
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Affiche un résumé du cortex et les neurones récents au lieu de la liste complète
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onShowHomeScreenChange?.(!showHomeScreen)}
                  style={{
                    flexShrink: 0,
                    width: 36, height: 20, borderRadius: 10,
                    background: showHomeScreen ? '#3dffaa' : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${showHomeScreen ? '#3dffaa' : 'rgba(255,255,255,0.15)'}`,
                    position: 'relative', cursor: 'pointer', transition: 'all 0.2s',
                  }}
                  title={showHomeScreen ? 'Désactiver l\'écran d\'accueil' : 'Activer l\'écran d\'accueil'}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: showHomeScreen ? 18 : 2,
                    width: 14, height: 14, borderRadius: 7,
                    background: showHomeScreen ? '#0a0014' : '#5a4a7a',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Capture images toggle */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div>
                  <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>
                    Conserver les images des articles
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Télécharge les images lors de la capture d'articles web (max 3 par neurone)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onCaptureImagesChange?.(!captureImages)}
                  style={{
                    flexShrink: 0,
                    width: 36, height: 20, borderRadius: 10,
                    background: captureImages ? '#3dffaa' : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${captureImages ? '#3dffaa' : 'rgba(255,255,255,0.15)'}`,
                    position: 'relative', cursor: 'pointer', transition: 'all 0.2s',
                  }}
                  title={captureImages ? 'Désactiver' : 'Activer'}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: captureImages ? 18 : 2,
                    width: 14, height: 14, borderRadius: 7,
                    background: captureImages ? '#0a0014' : '#5a4a7a',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Transfer images to mobile toggle */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ flex: 1 }}>
                  <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>
                    Transférer les images vers le mobile
                  </p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    {transferImages
                      ? 'Images disponibles sur mobile (via le réseau local)'
                      : 'OFF — recommandé : synchro texte légère, images chargées à la demande si PC allumé'}
                  </p>
                  {!transferImages && imageStats && imageStats.count > 0 && (
                    <p className="font-mono text-xs mt-1" style={{ color: '#f97316' }}>
                      Activer transférerait ~{imageStats.totalMb} Mo ({imageStats.count} image{imageStats.count > 1 ? 's' : ''}) vers l'appareil
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!transferImages && !imageStats) {
                      void cortexClient.imageStats().then(s => setImageStats(s));
                    }
                    onTransferImagesChange?.(!transferImages);
                  }}
                  style={{
                    flexShrink: 0,
                    width: 36, height: 20, borderRadius: 10,
                    background: transferImages ? '#f97316' : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${transferImages ? '#f97316' : 'rgba(255,255,255,0.15)'}`,
                    position: 'relative', cursor: 'pointer', transition: 'all 0.2s',
                  }}
                  title={transferImages ? 'Désactiver (recommandé)' : 'Activer'}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: transferImages ? 18 : 2,
                    width: 14, height: 14, borderRadius: 7,
                    background: transferImages ? '#0a0014' : '#5a4a7a',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Corpus de référence — volume monitor */}
              <div style={{ paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>Neurones "corpus" (référence)</p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Importés (fichiers) + capturés (recherche ciblée) — exclus du cortex 3D par défaut
                  </p>
                </div>
                <span className="font-mono font-semibold" style={{ color: '#84cc16', fontSize: 20, flexShrink: 0 }}>{corpusCount}</span>
              </div>

              {/* Gesture control sensitivity */}
              <div style={{ paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="flex items-center justify-between">
                  <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>Sensibilité du contrôle gestuel (Alt+C)</p>
                  <span className="font-mono font-semibold" style={{ color: '#3dffaa', fontSize: 14 }}>{gestureSensitivity}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={gestureSensitivity}
                  onChange={e => onGestureSensitivityChange?.(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#3dffaa' }}
                />
                <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                  1 = mouvements amples nécessaires · 10 = très réactif. Effectif immédiatement, sans relancer la caméra.
                </p>
              </div>

              {/* Easter egg — doigt d'honneur */}
              <div style={{ paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <p className="font-mono text-xs" style={{ color: '#c0b0e0' }}>Easter egg caméra (majeur tendu)</p>
                  <p className="font-mono text-xs mt-0.5" style={{ color: '#7a6c9a' }}>
                    Effet surprise déclenché en mode gestes. Aucune donnée perdue, aucun réglage modifié — visuel et sonore uniquement.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onEasterEggEnabledChange?.(!easterEggEnabled)}
                  style={{
                    flexShrink: 0,
                    width: 36, height: 20, borderRadius: 10,
                    background: easterEggEnabled ? '#3dffaa' : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${easterEggEnabled ? '#3dffaa' : 'rgba(255,255,255,0.15)'}`,
                    position: 'relative', cursor: 'pointer', transition: 'all 0.2s',
                  }}
                  title={easterEggEnabled ? 'Désactiver' : 'Activer'}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: easterEggEnabled ? 18 : 2,
                    width: 14, height: 14, borderRadius: 7,
                    background: easterEggEnabled ? '#0a0014' : '#5a4a7a',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Site shortcuts */}
              <div style={{ paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="flex items-center gap-2 mb-1">
                  <Link2 size={13} style={{ color: '#5ee7ff', flexShrink: 0 }} />
                  <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>
                    Raccourcis de sites
                  </p>
                </div>
                <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>
                  Tapez <span style={{ color: '#c0b0e0' }}>ouvre [nom]</span> pour ouvrir directement un site (à l'écrit ou à la voix). Vos raccourcis personnalisés ont priorité sur les sites intégrés (ex : <span style={{ color: '#c0b0e0' }}>nomad</span> → <span style={{ color: '#c0b0e0' }}>http://localhost:8080</span> pour une instance locale).
                </p>

                {/* Custom shortcuts list */}
                {Object.keys(customShortcuts).length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    {Object.entries(customShortcuts).map(([name, url]) => (
                      <div key={name} className="flex items-center gap-2 px-3 py-2 rounded"
                        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <span className="font-mono text-xs font-semibold" style={{ color: '#5ee7ff', minWidth: 80 }}>{name}</span>
                        <span className="font-mono text-xs flex-1 truncate" style={{ color: '#7a6c9a' }}>{url}</span>
                        <button
                          type="button"
                          disabled={scSaving}
                          onClick={async () => {
                            setScSaving(true);
                            try { await onDeleteShortcut?.(name); } finally { setScSaving(false); }
                          }}
                          style={{ color: '#5a4a7a', flexShrink: 0 }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#ff4d58')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#5a4a7a')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add shortcut form */}
                <div className="flex gap-2 mt-1">
                  <input
                    type="text"
                    placeholder="nom"
                    value={scName}
                    onChange={e => { setScName(e.target.value); setScError(null); }}
                    className="font-mono text-xs"
                    style={{
                      width: 90, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 6, padding: '5px 8px', color: '#e8d9ff', outline: 'none',
                    }}
                  />
                  <input
                    type="text"
                    placeholder="https://..."
                    value={scUrl}
                    onChange={e => { setScUrl(e.target.value); setScError(null); }}
                    className="font-mono text-xs flex-1"
                    style={{
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 6, padding: '5px 8px', color: '#e8d9ff', outline: 'none',
                    }}
                    onKeyDown={async e => { if (e.key === 'Enter') await addShortcut(); }}
                  />
                  <button
                    type="button"
                    disabled={scSaving || !scName.trim() || !scUrl.trim()}
                    onClick={() => void addShortcut()}
                    style={{
                      flexShrink: 0, padding: '5px 10px', borderRadius: 6,
                      background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.25)',
                      color: '#3dffaa', cursor: scSaving || !scName.trim() || !scUrl.trim() ? 'default' : 'pointer',
                      opacity: !scName.trim() || !scUrl.trim() ? 0.4 : 1,
                    }}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {scError && (
                  <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{scError}</p>
                )}
              </div>
            </div>
          )}

          {!loading && !error && tab === 'stats' && (
            <div className="px-5 py-4">
              {stats.length === 0 && !whisperStats && (
                <p className="font-mono text-xs py-6 text-center" style={{ color: '#3d3060' }}>
                  Aucun appel LLM enregistré pour l'instant
                </p>
              )}
              {stats.length > 0 && (
                <div className="flex flex-col gap-3">
                  <p className="font-mono text-xs mb-1" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                    USAGE PAR MODÈLE
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '4px 16px', alignItems: 'center' }}>
                    {['Modèle', 'Appels', 'Latence moy.', 'Erreurs'].map(h => (
                      <span key={h} className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.1em' }}>{h}</span>
                    ))}
                    {stats.map((s, i) => (
                      <Fragment key={`${s.chosen_model}-${s.chosen_level}-${i}`}>
                        <span className="font-mono text-xs" style={{ color: '#9080c0' }}>
                          {s.chosen_model}
                          <span style={{ color: '#3d3060', marginLeft: 5, fontSize: 10 }}>L{s.chosen_level}</span>
                        </span>
                        <span className="font-mono text-xs" style={{ color: '#5ee7ff', textAlign: 'right' }}>{s.call_count}</span>
                        <span className="font-mono text-xs" style={{ color: '#7a6c9a', textAlign: 'right' }}>{formatLatency(s.avg_latency_ms)}</span>
                        <span className="font-mono text-xs" style={{ color: s.error_count > 0 ? '#ff4d58' : '#3d3060', textAlign: 'right' }}>{s.error_count}</span>
                      </Fragment>
                    ))}
                  </div>

                  <div className="mt-3">
                    <p className="font-mono text-xs mb-2" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                      RÉPARTITION PAR NIVEAU
                    </p>
                    {[1, 2, 3, 4, 5].map(level => {
                      const total = stats.reduce((s, r) => s + r.call_count, 0);
                      const count = stats.filter(r => r.chosen_level === level).reduce((s, r) => s + r.call_count, 0);
                      if (count === 0 && level >= 4) return null;
                      const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
                      const color = LEVEL_COLORS[level] ?? (level === 4 ? '#5ee7ff' : '#a78bfa');
                      return (
                        <div key={level} className="flex items-center gap-3 mb-1.5">
                          <span className="font-mono" style={{ fontSize: 10, color, width: 20 }}>L{level}</span>
                          <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s' }} />
                          </div>
                          <span className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', width: 30, textAlign: 'right' }}>{count}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Cloud usage this month — always shown, even at 0 calls */}
                  <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(94,231,255,0.1)' }}>
                    <p className="font-mono text-xs mb-2" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                      CLOUD — CE MOIS
                    </p>
                    {CLOUD_PROVIDERS.map(prov => {
                      const activeKey = `${prov.id}_active` as keyof CloudKeysMasked;
                      const isConfigured = cloudKeys ? !!cloudKeys[activeKey] : false;
                      // Sum all rows for this provider (provider may appear with several models)
                      const rows = cloudMonth.filter(r => r.provider === prov.id);
                      const callCount  = rows.reduce((s, r) => s + r.call_count,  0);
                      const errCount   = rows.reduce((s, r) => s + r.error_count, 0);
                      const quotaCount = rows.reduce((s, r) => s + (r.quota_count ?? 0), 0);
                      // Best model label: most-used row, or the provider note
                      const modelLabel = rows.length > 0
                        ? rows.reduce((best, r) => r.call_count > best.call_count ? r : best, rows[0]).chosen_model
                        : prov.note;
                      return (
                        <div key={prov.id} className="mb-2 pb-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          {/* Provider header row */}
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-mono" style={{ fontSize: 10, color: prov.color, fontWeight: 600 }}>{prov.label}</span>
                            <span
                              className="font-mono"
                              style={{
                                fontSize: 8,
                                letterSpacing: '0.08em',
                                padding: '1px 5px',
                                borderRadius: 3,
                                background: isConfigured ? 'rgba(61,255,170,0.1)' : 'rgba(255,255,255,0.04)',
                                color: isConfigured ? '#3dffaa' : '#4a3d6a',
                              }}
                            >
                              {isConfigured ? 'CONFIGURÉ' : 'NON CONFIGURÉ'}
                            </span>
                          </div>
                          {/* Stats row */}
                          <div className="flex items-center gap-4">
                            <span className="font-mono truncate" style={{ fontSize: 9, color: '#5a4a7a', flex: 1 }}>{modelLabel}</span>
                            <span className="font-mono" style={{ fontSize: 9, color: callCount > 0 ? '#5ee7ff' : '#3d3060' }}>
                              {callCount} appel{callCount !== 1 ? 's' : ''}
                            </span>
                            {errCount > 0 && (
                              <span className="font-mono" style={{ fontSize: 9, color: '#ff4d58' }}>{errCount} err</span>
                            )}
                            {quotaCount > 0 && (
                              <span className="font-mono" style={{ fontSize: 9, color: '#f59e0b' }}>{quotaCount}×429</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Whisper transcription stats — always shown when data available */}
              {whisperStats && (() => {
                const GROQ_DAILY_LIMIT_MIN = 480;
                const usedMin = whisperStats.today.groq_minutes;
                const remainingMin = Math.max(0, GROQ_DAILY_LIMIT_MIN - usedMin);
                const usedPct = Math.min(100, Math.round((usedMin / GROQ_DAILY_LIMIT_MIN) * 100));
                const totalToday = whisperStats.today.groq + whisperStats.today.local;
                const groqPct = totalToday > 0 ? Math.round((whisperStats.today.groq / totalToday) * 100) : 0;
                return (
                  <div className="mt-2 pt-3" style={{ borderTop: '1px solid rgba(249,115,22,0.15)' }}>
                    <p className="font-mono text-xs mb-3" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                      WHISPER — TRANSCRIPTIONS
                    </p>

                    {/* Local vs Cloud bar */}
                    {totalToday > 0 && (
                      <div className="mb-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono" style={{ fontSize: 9, color: '#f97316' }}>⚡ Groq {groqPct}%</span>
                          <span className="font-mono" style={{ fontSize: 9, color: '#34d399' }}>🔒 Local {100 - groqPct}%</span>
                        </div>
                        <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${groqPct}%`, height: '100%', background: '#f97316', borderRadius: 2, transition: 'width 0.4s' }} />
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '6px 16px', alignItems: 'center' }}>
                      <span className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.1em' }}>Provider</span>
                      <span className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.1em', textAlign: 'right' }}>Aujourd&apos;hui</span>
                      <span className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.1em', textAlign: 'right' }}>Ce mois</span>

                      <div className="flex items-center gap-1.5">
                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)', color: '#f97316' }}>⚡ GROQ</span>
                      </div>
                      <span className="font-mono text-xs" style={{ color: '#5ee7ff', textAlign: 'right' }}>
                        {whisperStats.today.groq}{usedMin > 0 ? ` (${usedMin} min)` : ''}
                      </span>
                      <span className="font-mono text-xs" style={{ color: '#7a6c9a', textAlign: 'right' }}>{whisperStats.month.groq}</span>

                      <div className="flex items-center gap-1.5">
                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', color: '#34d399' }}>🔒 LOCAL</span>
                      </div>
                      <span className="font-mono text-xs" style={{ color: '#5ee7ff', textAlign: 'right' }}>
                        {whisperStats.today.local}{whisperStats.today.local_minutes > 0 ? ` (${whisperStats.today.local_minutes} min)` : ''}
                      </span>
                      <span className="font-mono text-xs" style={{ color: '#7a6c9a', textAlign: 'right' }}>{whisperStats.month.local}</span>
                    </div>

                    {/* Groq daily quota bar */}
                    <div className="mt-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.1em' }}>QUOTA GROQ / JOUR</span>
                        <span className="font-mono" style={{ fontSize: 9, color: remainingMin === 0 ? '#ff4d58' : remainingMin < 60 ? '#f97316' : '#34d399' }}>
                          {remainingMin > 0 ? `~${remainingMin} min restantes` : 'épuisé'}
                        </span>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          width: `${usedPct}%`, height: '100%', borderRadius: 2, transition: 'width 0.4s',
                          background: usedPct >= 90 ? '#ff4d58' : usedPct >= 70 ? '#f97316' : '#f97316',
                        }} />
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="font-mono" style={{ fontSize: 8, color: '#3d3060' }}>{usedMin} min utilisées</span>
                        <span className="font-mono" style={{ fontSize: 8, color: '#3d3060' }}>{GROQ_DAILY_LIMIT_MIN} min/jour (free tier)</span>
                      </div>
                    </div>

                    {whisperStats.last_quota_at && (() => {
                      const d = new Date(whisperStats.last_quota_at);
                      const hourAgo = Date.now() - d.getTime() < 60 * 60 * 1000;
                      return (
                        <p className="font-mono mt-2" style={{ fontSize: 9, color: hourAgo ? '#f97316' : '#5a4a7a' }}>
                          {hourAgo ? '⚠️' : '•'} Dernier quota Groq : {d.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                          {hourAgo ? ' — routage Auto bascule sur local' : ''}
                        </p>
                      );
                    })()}
                  </div>
                );
              })()}
              {/* LanceDB index health — fragment stats + compaction button */}
              {indexStats && (
                <div className="mt-2 pt-3" style={{ borderTop: '1px solid rgba(94,231,255,0.12)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>
                      INDEX VECTORIEL (LanceDB)
                    </p>
                    {indexStats.numFragments > 100 && (
                      <span className="font-mono" style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24' }}>
                        ⚠️ FRAGMENTÉ
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
                    <div>
                      <span className="font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>Neurones : </span>
                      <span className="font-mono" style={{ fontSize: 9, color: '#5ee7ff' }}>{indexStats.numRows.toLocaleString('fr-FR')}</span>
                    </div>
                    <div>
                      <span className="font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>Fragments : </span>
                      <span className="font-mono" style={{ fontSize: 9, color: indexStats.numFragments > 500 ? '#f97316' : indexStats.numFragments > 100 ? '#fbbf24' : '#3dffaa' }}>
                        {indexStats.numFragments.toLocaleString('fr-FR')}
                      </span>
                    </div>
                    <div>
                      <span className="font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>Index ANN : </span>
                      <span className="font-mono" style={{ fontSize: 9, color: indexStats.numIndices > 0 ? '#3dffaa' : '#3d3060' }}>
                        {indexStats.numIndices > 0 ? `${indexStats.numIndices} index` : 'scan linéaire'}
                      </span>
                    </div>
                    <div>
                      <span className="font-mono" style={{ fontSize: 9, color: '#5a4a7a' }}>Taille : </span>
                      <span className="font-mono" style={{ fontSize: 9, color: '#7a6c9a' }}>
                        {((indexStats.diskBytes ?? indexStats.totalBytes) / 1_048_576).toFixed(1)} Mo sur disque
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-3">
                    <button
                      type="button"
                      disabled={optimizing}
                      onClick={async () => {
                        setOptimizing(true);
                        setOptimizeResult(null);
                        try {
                          const r = await cortexClient.optimizeIndex();
                          if (r.skipped) {
                            setOptimizeResult('Index vide ou déjà optimisé.');
                          } else {
                            setOptimizeResult(`✓ ${r.before?.fragments ?? '?'} → ${r.after?.fragments ?? '?'} fragments · ${((r.before?.bytes ?? 0) / 1_048_576).toFixed(1)} → ${((r.after?.bytes ?? 0) / 1_048_576).toFixed(1)} Mo · ${((r.durationMs ?? 0) / 1000).toFixed(1)} s · ${r.before?.rows} → ${r.after?.rows} entrées`);
                            cortexClient.getIndexStats().then(s => s && setIndexStats(s)).catch(() => {});
                          }
                        } catch (e) {
                          setOptimizeResult(`Erreur : ${(e as Error).message}`);
                        } finally {
                          setOptimizing(false);
                        }
                      }}
                      className="font-mono"
                      style={{
                        fontSize: 10, padding: '3px 10px', borderRadius: 5, cursor: optimizing ? 'default' : 'pointer',
                        background: optimizing ? 'rgba(255,255,255,0.04)' : 'rgba(94,231,255,0.1)',
                        border: `1px solid ${optimizing ? 'rgba(255,255,255,0.08)' : 'rgba(94,231,255,0.25)'}`,
                        color: optimizing ? '#3d3060' : '#5ee7ff',
                      }}
                    >
                      {optimizing ? '⏳ Compaction…' : 'Compacter maintenant'}
                    </button>
                    {optimizeResult && (
                      <span className="font-mono" style={{ fontSize: 9, color: optimizeResult.startsWith('✓') ? '#3dffaa' : '#ff4d58' }}>
                        {optimizeResult}
                      </span>
                    )}
                  </div>
                  <p className="font-mono mt-1" style={{ fontSize: 9, color: '#2e2555' }}>
                    Contrôle automatique toutes les 5 minutes : seuil {indexStats.autoCompactThreshold ?? 1000} fragments ou anciennes versions volumineuses. Peut prendre quelques minutes.
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === 'vocal' && (
            <div className="px-5 py-4 flex flex-col gap-5">
              {voiceError && (
                <div className="font-mono text-xs px-3 py-2 rounded" style={{ background: 'rgba(255,77,88,0.1)', color: '#ff4d58' }}>
                  {voiceError}
                </div>
              )}

              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-xs" style={{ color: '#e2d9f3', letterSpacing: '0.08em' }}>Activer l'interface vocale</p>
                  <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', marginTop: 2 }}>
                    Bouton micro dans la barre · raccourci Alt+M
                  </p>
                </div>
                <button
                  type="button"
                  disabled={voiceSaving || !voiceSettings}
                  onClick={() => saveVoiceSetting({ enabled: !voiceSettings?.enabled })}
                  className="font-mono text-xs px-3 py-1.5 rounded"
                  style={{
                    background: voiceSettings?.enabled ? 'rgba(61,255,170,0.15)' : 'rgba(90,74,122,0.2)',
                    color: voiceSettings?.enabled ? '#3dffaa' : '#5a4a7a',
                    border: `1px solid ${voiceSettings?.enabled ? 'rgba(61,255,170,0.3)' : 'rgba(90,74,122,0.3)'}`,
                  }}
                >
                  {voiceSettings?.enabled ? 'ACTIVÉ' : 'DÉSACTIVÉ'}
                </button>
              </div>

              {/* Transcription mode */}
              <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                  TRANSCRIPTION
                </p>
                <div className="flex gap-2">
                  {(['local', 'groq'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      disabled={voiceSaving || !voiceSettings}
                      onClick={() => saveVoiceSetting({ whisperMode: mode })}
                      className="font-mono text-xs px-3 py-1.5 rounded flex-1"
                      style={{
                        background: voiceSettings?.whisperMode === mode ? 'rgba(61,255,170,0.15)' : 'rgba(26,20,42,0.6)',
                        color: voiceSettings?.whisperMode === mode ? '#3dffaa' : '#5a4a7a',
                        border: `1px solid ${voiceSettings?.whisperMode === mode ? 'rgba(61,255,170,0.3)' : 'rgba(90,74,122,0.2)'}`,
                      }}
                    >
                      {mode === 'local' ? '🖥 Local (faster-whisper)' : '☁ Groq Whisper'}
                    </button>
                  ))}
                </div>
                {voiceSettings?.whisperMode === 'groq' && (
                  <p className="font-mono mt-2" style={{ fontSize: 10, color: '#ffb547', lineHeight: 1.6 }}>
                    ⚠ Votre voix sera envoyée à Groq Cloud pour transcription. Requiert une clé Groq configurée dans l'onglet Modèles.
                  </p>
                )}
                {voiceSettings?.whisperMode === 'local' && (
                  <p className="font-mono mt-2" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.6 }}>
                    Utilise faster-whisper (modèle small, CPU) — 100% local.
                  </p>
                )}
              </div>

              {/* Push-to-talk note */}
              <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
                <p className="font-mono mb-1" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                  PUSH-TO-TALK (sans configuration)
                </p>
                <p className="font-mono text-xs" style={{ color: '#5a4a7a', lineHeight: 1.6 }}>
                  Cliquez sur le bouton <Mic size={10} style={{ display: 'inline', marginBottom: -2 }} /> dans la barre du haut,
                  ou appuyez sur <strong style={{ color: '#e2d9f3' }}>Alt+M</strong> n'importe où dans l'app.
                  La dictée s'arrête automatiquement après 2 secondes de silence.
                </p>
              </div>

              {/* Porcupine wake word setup */}
              <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                  MOT D'ACTIVATION "HEY DOCTEUR" (optionnel)
                </p>
                <p className="font-mono text-xs mb-3" style={{ color: '#5a4a7a', lineHeight: 1.7 }}>
                  Permet d'activer le micro à la voix sans toucher au clavier.
                  Utilise <strong style={{ color: '#e2d9f3' }}>Porcupine Web</strong> (Picovoice) — traitement 100% local (WebAssembly).
                </p>

                <div className="font-mono flex flex-col gap-2 mb-3" style={{ fontSize: 10, color: '#7a6c9a', lineHeight: 1.7 }}>
                  <div>1. Créez un compte gratuit sur <strong style={{ color: '#5ee7ff' }}>picovoice.ai</strong> → copiez votre AccessKey</div>
                  <div>2. Allez sur <strong style={{ color: '#5ee7ff' }}>console.picovoice.ai</strong> → Porcupine → créez un mot-clé</div>
                  <div>3. Entrez <strong style={{ color: '#e2d9f3' }}>"Hey Docteur"</strong>, plateforme : <strong style={{ color: '#e2d9f3' }}>Chrome / Web</strong></div>
                  <div>4. Téléchargez le fichier <strong style={{ color: '#e2d9f3' }}>.ppn</strong> et importez-le ci-dessous</div>
                </div>

                {/* AccessKey */}
                <label className="font-mono block mb-1" style={{ fontSize: 10, color: '#5a4a7a' }}>AccessKey Picovoice</label>
                <div className="flex gap-2 mb-3">
                  <input
                    type="password"
                    className="font-mono text-xs px-3 py-1.5 rounded flex-1"
                    style={{ background: 'rgba(26,20,42,0.8)', border: '1px solid rgba(90,74,122,0.3)', color: '#e2d9f3' }}
                    placeholder="Votre AccessKey Picovoice…"
                    defaultValue={voiceSettings?.porcupineAccessKey ?? ''}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val !== (voiceSettings?.porcupineAccessKey ?? '')) {
                        void saveVoiceSetting({ porcupineAccessKey: val || null });
                      }
                    }}
                  />
                </div>

                {/* Model upload */}
                <div className="flex items-center gap-3">
                  <input
                    ref={ppnInputRef}
                    type="file"
                    accept=".ppn"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handlePpnUpload(file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    disabled={ppnUploading}
                    onClick={() => ppnInputRef.current?.click()}
                    className="font-mono text-xs px-3 py-1.5 rounded flex items-center gap-2"
                    style={{ background: 'rgba(94,231,255,0.1)', color: '#5ee7ff', border: '1px solid rgba(94,231,255,0.2)' }}
                  >
                    <Upload size={11} />
                    {ppnUploading ? 'Import…' : 'Importer .ppn'}
                  </button>
                  {voiceSettings?.hasPorcupineModel && (
                    <span className="font-mono" style={{ fontSize: 10, color: '#3dffaa' }}>
                      <CheckCircle size={11} style={{ display: 'inline', marginBottom: -2 }} /> Modèle configuré
                    </span>
                  )}
                </div>

                {voiceSettings?.porcupineAccessKey && voiceSettings?.hasPorcupineModel && (
                  <p className="font-mono mt-3" style={{ fontSize: 10, color: '#3dffaa', lineHeight: 1.6 }}>
                    ✓ Porcupine configuré — dites <strong>"Hey Docteur"</strong> pour activer le micro.
                  </p>
                )}
              </div>

              {/* Security reminders */}
              <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                  GARANTIES DE SÉCURITÉ
                </p>
                <ul className="font-mono flex flex-col gap-1" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.7 }}>
                  <li>• L'écoute du mot d'activation ne sort jamais de la machine</li>
                  <li>• Les enregistrements sont supprimés immédiatement après transcription</li>
                  <li>• Les commandes vocales ne peuvent pas supprimer de données</li>
                  <li>• Aucun audio ni transcription dans les logs</li>
                  {voiceSettings?.whisperMode === 'local' && <li style={{ color: '#3dffaa' }}>• Transcription 100% locale — rien ne quitte votre machine</li>}
                </ul>
              </div>
            </div>
          )}

          {tab === 'privacy' && (
            <div className="px-5 py-4 flex flex-col gap-5">
              {/* Test button */}
              <div>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                  VERROU DE SORTIE
                </p>
                <p className="font-mono text-xs mb-3" style={{ color: '#5a4a7a', lineHeight: 1.6 }}>
                  Vérifie que les données des neurones privés (CV, candidatures, marqués 🔒) ne peuvent pas
                  atteindre un provider cloud. Test déterministe — aucune requête réseau émise.
                </p>
                <button
                  type="button"
                  disabled={privacyTestRunning}
                  onClick={async () => {
                    setPrivacyTestRunning(true);
                    setPrivacyTestResult(null);
                    setPrivacyTestError(null);
                    try {
                      const r = await cortexClient.privacyTest();
                      setPrivacyTestResult(r);
                    } catch (e) {
                      setPrivacyTestError(e instanceof Error ? e.message : 'Erreur inconnue');
                    } finally {
                      setPrivacyTestRunning(false);
                    }
                  }}
                  className="flex items-center gap-2 font-mono text-xs px-4 py-2 rounded"
                  style={{
                    background: 'rgba(61,255,170,0.07)',
                    border: '1px solid rgba(61,255,170,0.2)',
                    color: privacyTestRunning ? '#3d3060' : '#3dffaa',
                    cursor: privacyTestRunning ? 'not-allowed' : 'pointer',
                  }}
                >
                  {privacyTestRunning
                    ? <><RefreshCw size={11} className="animate-spin" /> Test en cours…</>
                    : <><ShieldCheck size={11} /> Tester l'étanchéité des données privées</>
                  }
                </button>

                {privacyTestError && (
                  <p className="font-mono text-xs mt-2" style={{ color: '#ff4d58' }}>{privacyTestError}</p>
                )}

                {privacyTestResult && (
                  <div className="mt-3 rounded p-3" style={{
                    background: privacyTestResult.ok ? 'rgba(61,255,170,0.05)' : 'rgba(255,77,88,0.07)',
                    border: `1px solid ${privacyTestResult.ok ? 'rgba(61,255,170,0.2)' : 'rgba(255,77,88,0.3)'}`,
                  }}>
                    <div className="flex items-center gap-2 mb-2">
                      {privacyTestResult.ok
                        ? <CheckCircle size={13} style={{ color: '#3dffaa' }} />
                        : <AlertTriangle size={13} style={{ color: '#ff4d58' }} />
                      }
                      <span className="font-mono text-xs" style={{ color: privacyTestResult.ok ? '#3dffaa' : '#ff4d58', fontWeight: 600 }}>
                        {privacyTestResult.ok ? 'ÉTANCHE — tous les providers bloquent les données privées' : 'FUITE DÉTECTÉE — vérifier le verrou'}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '3px 12px' }}>
                      {['Provider', 'Privé bloqué', 'Neutre passé'].map(h => (
                        <span key={h} className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>{h}</span>
                      ))}
                      {privacyTestResult.results.map(r => (
                        <Fragment key={r.provider}>
                          <span className="font-mono text-xs" style={{ color: '#9080c0' }}>{r.provider}</span>
                          <span className="font-mono" style={{ fontSize: 11, color: r.blocked_private ? '#3dffaa' : '#ff4d58', textAlign: 'center' }}>
                            {r.blocked_private ? '✓' : '✗'}
                          </span>
                          <span className="font-mono" style={{ fontSize: 11, color: r.passed_neutral ? '#3dffaa' : '#ff4d58', textAlign: 'center' }}>
                            {r.passed_neutral ? '✓' : '✗'}
                          </span>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Violations log */}
              <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
                <div className="flex items-center justify-between mb-2">
                  <p className="font-mono" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                    JOURNAL DES INCIDENTS ({privacyViolations.length})
                  </p>
                  <button
                    type="button"
                    onClick={() => cortexClient.privacyViolations(100).then(r => setPrivacyViolations(r.violations)).catch(() => {})}
                    className="font-mono flex items-center gap-1"
                    style={{ fontSize: 10, color: '#5a4a7a' }}
                  >
                    <RefreshCw size={9} /> actualiser
                  </button>
                </div>
                {privacyViolations.length === 0 ? (
                  <p className="font-mono text-xs" style={{ color: '#3d3060' }}>Aucun incident — aucune tentative de fuite détectée.</p>
                ) : (
                  <div className="flex flex-col gap-1" style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {privacyViolations.map(v => (
                      <div key={v.id} className="font-mono flex items-center gap-3 py-1"
                        style={{ fontSize: 10, borderBottom: '1px solid rgba(255,77,88,0.08)' }}>
                        <span style={{ color: '#5a4a7a', whiteSpace: 'nowrap' }}>
                          {new Date(v.occurred_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                        <span style={{ color: '#ff4d58', flex: 1 }}>{v.provider_targeted}</span>
                        <span style={{ color: '#7a6c9a' }}>{v.function_called}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'inbox' && (
            <div className="px-5 py-4 flex flex-col gap-5">
              {inboxError && (
                <div style={{ padding: '8px 12px', background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.2)', borderRadius: 6, fontSize: 12, color: '#ff4d58', fontFamily: 'monospace' }}>
                  {inboxError}
                </div>
              )}

              {/* Enable toggle */}
              <div>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                  DOSSIER SURVEILLÉ
                </p>
                <p className="font-mono text-xs mb-3" style={{ color: '#5a4a7a', lineHeight: 1.6 }}>
                  Agents externes (OpenWorker ou autre) déposent des fichiers dans un dossier local.
                  Docteur les importe automatiquement comme neurones de type «&nbsp;Rapport&nbsp;»,
                  sans aucun endpoint réseau exposé.
                </p>
                <button
                  type="button"
                  disabled={inboxSaving || !inboxSettings}
                  onClick={() => saveInboxSetting({ enabled: !inboxSettings?.enabled })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 14px', borderRadius: 7, width: '100%',
                    border: `1px solid ${inboxSettings?.enabled ? 'rgba(61,255,170,0.3)' : 'rgba(255,255,255,0.1)'}`,
                    background: inboxSettings?.enabled ? 'rgba(61,255,170,0.06)' : 'rgba(255,255,255,0.02)',
                    cursor: (inboxSaving || !inboxSettings) ? 'default' : 'pointer',
                  }}
                >
                  <div style={{
                    width: 32, height: 18, borderRadius: 9, flexShrink: 0, transition: 'background 0.2s',
                    background: inboxSettings?.enabled ? 'rgba(61,255,170,0.5)' : 'rgba(255,255,255,0.1)',
                    position: 'relative',
                  }}>
                    <div style={{
                      position: 'absolute', top: 3, left: inboxSettings?.enabled ? 16 : 3,
                      width: 12, height: 12, borderRadius: '50%', transition: 'left 0.2s',
                      background: inboxSettings?.enabled ? '#3dffaa' : '#7a6c9a',
                    }} />
                  </div>
                  <span className="font-mono text-xs" style={{ color: inboxSettings?.enabled ? '#3dffaa' : '#7a6c9a' }}>
                    {inboxSettings?.enabled ? 'Activé' : 'Désactivé (défaut)'}
                  </span>
                </button>
              </div>

              {inboxSettings?.enabled && (
                <>
                  {/* Folder path */}
                  <div>
                    <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                      DOSSIER
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        defaultValue={inboxSettings.inbox_dir ?? ''}
                        onBlur={e => {
                          const val = e.target.value.trim();
                          if (val && val !== inboxSettings.inbox_dir) saveInboxSetting({ inbox_dir: val });
                        }}
                        placeholder="cortex-server/data/inbox"
                        style={{
                          flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12,
                          fontFamily: 'monospace', outline: 'none',
                        }}
                      />
                    </div>
                    <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', marginTop: 4 }}>
                      Chemin absolu ou relatif au dossier cortex-server/.
                    </p>
                  </div>

                  {/* Frequency */}
                  <div>
                    <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>
                      FRÉQUENCE DE VÉRIFICATION
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['daily', 'hourly', 'manual'] as const).map(f => (
                        <button
                          key={f} type="button"
                          disabled={inboxSaving}
                          onClick={() => saveInboxSetting({ frequency: f })}
                          style={{
                            flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 11, cursor: inboxSaving ? 'default' : 'pointer',
                            fontFamily: 'monospace',
                            border: inboxSettings.frequency === f ? '1px solid #5ee7ff' : '1px solid rgba(255,255,255,0.1)',
                            background: inboxSettings.frequency === f ? 'rgba(94,231,255,0.08)' : 'rgba(255,255,255,0.02)',
                            color: inboxSettings.frequency === f ? '#5ee7ff' : '#7a6c9a',
                          }}
                        >
                          {f === 'daily' ? 'Quotidien' : f === 'hourly' ? 'Horaire' : 'Manuel'}
                        </button>
                      ))}
                    </div>
                    <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', marginTop: 4 }}>
                      En mode manuel, seul «&nbsp;Vérifier maintenant&nbsp;» déclenche l'import.
                      Les vérifications planifiées s'exécutent au démarrage si le délai est écoulé.
                    </p>
                  </div>

                  {/* Check now + last check */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button
                        type="button"
                        disabled={inboxChecking}
                        onClick={handleCheckNow}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '7px 16px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
                          border: '1px solid rgba(94,231,255,0.3)',
                          background: 'rgba(94,231,255,0.06)',
                          color: inboxChecking ? '#5a4a7a' : '#5ee7ff',
                          cursor: inboxChecking ? 'default' : 'pointer',
                        }}
                      >
                        <RefreshCw size={11} className={inboxChecking ? 'animate-spin' : ''} />
                        {inboxChecking ? 'Vérification…' : 'Vérifier maintenant'}
                      </button>
                      {inboxSettings.last_check && (
                        <span className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>
                          Dernière vérification : {new Date(inboxSettings.last_check).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                      )}
                    </div>

                    {inboxCheckResult && (
                      <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, background: 'rgba(61,255,170,0.06)', border: '1px solid rgba(61,255,170,0.15)', fontSize: 12, fontFamily: 'monospace' }}>
                        {inboxCheckResult.processed === 0 && inboxCheckResult.errors === 0
                          ? <span style={{ color: '#5a4a7a' }}>Aucun fichier à importer.</span>
                          : <>
                            {inboxCheckResult.processed > 0 && (
                              <div style={{ color: '#3dffaa' }}>
                                ✓ {inboxCheckResult.processed} rapport{inboxCheckResult.processed > 1 ? 's' : ''} importé{inboxCheckResult.processed > 1 ? 's' : ''}
                              </div>
                            )}
                            {inboxCheckResult.errors > 0 && (
                              <div style={{ color: '#ff4d58', marginTop: 2 }}>
                                ✗ {inboxCheckResult.errors} fichier{inboxCheckResult.errors > 1 ? 's' : ''} en erreur → dossier <code>erreurs/</code>
                              </div>
                            )}
                          </>
                        }
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Documentation */}
              <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="font-mono mb-3" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>DOCUMENTATION</p>
                <div style={{ fontSize: 11, color: '#7a6c9a', fontFamily: 'monospace', lineHeight: 1.8 }}>
                  <div><span style={{ color: '#5ee7ff' }}>Dossier par défaut :</span> cortex-server/data/inbox/</div>
                  <div style={{ marginTop: 6 }}><span style={{ color: '#5ee7ff' }}>Formats supportés :</span></div>
                  <div style={{ paddingLeft: 12 }}>▸ <span style={{ color: '#e2e8f0' }}>.md / .txt</span> — le contenu devient le neurone, titre depuis le premier # heading</div>
                  <div style={{ paddingLeft: 12 }}>▸ <span style={{ color: '#e2e8f0' }}>.json</span> — champs title, content, source (opt.), tags (opt.)</div>
                  <div style={{ paddingLeft: 12 }}>▸ Autres extensions ignorées silencieusement</div>
                  <div style={{ marginTop: 6 }}><span style={{ color: '#5ee7ff' }}>Limites :</span> 2 Mo par fichier · 20 fichiers par cycle</div>
                  <div style={{ marginTop: 6 }}><span style={{ color: '#5ee7ff' }}>Après import :</span> fichiers déplacés vers <code style={{ color: '#3dffaa' }}>inbox/traites/</code></div>
                  <div><span style={{ color: '#5ee7ff' }}>En erreur :</span> fichier + log → <code style={{ color: '#ff4d58' }}>inbox/erreurs/</code></div>
                  <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
                    <span style={{ color: '#5ee7ff' }}>Exemple JSON :</span>
                  </div>
                  <pre style={{ marginTop: 6, padding: '10px 12px', background: 'rgba(61,255,170,0.03)', border: '1px solid rgba(61,255,170,0.1)', borderRadius: 6, fontSize: 10, color: '#c8bcdf', overflowX: 'auto', lineHeight: 1.7 }}>{`{
  "title": "Rapport veille IA — semaine 32",
  "content": "## Résumé\\n\\nPoints clés de la semaine...",
  "source": "OpenWorker agent",
  "tags": ["ia", "veille", "hebdo"]
}`}</pre>
                </div>
              </div>
            </div>
          )}

          {tab === 'files' && (
            <div className="px-5 py-4 flex flex-col gap-4">
              {filesError && (
                <div style={{ padding: '8px 12px', background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.2)', borderRadius: 6, fontSize: 12, color: '#ff4d58', fontFamily: 'monospace' }}>
                  {filesError}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.9fr', gap: 14, alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      void handleFileSelection(e.dataTransfer.files);
                    }}
                    style={{
                      padding: 16,
                      borderRadius: 10,
                      border: '1px dashed rgba(94,231,255,0.25)',
                      background: 'rgba(94,231,255,0.03)',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <Upload size={16} style={{ color: '#5ee7ff', flexShrink: 0 }} />
                      <div>
                        <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>Déposer un fichier</p>
                        <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Excel, CSV, texte, Markdown, JSON · max 20 Mo</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={filesUploading}
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.multiple = true;
                        input.accept = '.xlsx,.csv,.txt,.md,.json';
                        input.onchange = () => { if (input.files) void handleFileSelection(input.files); };
                        input.click();
                      }}
                      className="font-mono text-xs mt-3 px-3 py-2 rounded"
                      style={{
                        width: '100%',
                        background: 'rgba(94,231,255,0.08)',
                        border: '1px solid rgba(94,231,255,0.22)',
                        color: filesUploading ? '#5a4a7a' : '#5ee7ff',
                        cursor: filesUploading ? 'default' : 'pointer',
                      }}
                    >
                      {filesUploading ? 'Envoi…' : 'Choisir un ou plusieurs fichiers'}
                    </button>
                  </div>

                  <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <p className="font-mono text-xs mb-2" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>EMPLACEMENTS</p>
                    <div className="font-mono text-xs" style={{ color: '#7a6c9a', lineHeight: 1.7 }}>
                      <div><span style={{ color: '#5ee7ff' }}>Originaux :</span> {filesIndex?.paths.originals ?? 'cortex-server/data/fichiers/originaux'}</div>
                      <div><span style={{ color: '#5ee7ff' }}>Résultats :</span> {filesIndex?.paths.results ?? 'cortex-server/data/fichiers/resultats'}</div>
                      <div><span style={{ color: '#5ee7ff' }}>Sauvegarde :</span> métadonnées uniquement, pas les blobs</div>
                    </div>
                  </div>

                  <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>ORIGINAUX ({filesIndex?.originals.length ?? 0})</p>
                      <button type="button" className="font-mono text-xs" style={{ color: '#5a4a7a' }} onClick={() => { void refreshFiles(); }}>
                        <RefreshCw size={10} /> actualiser
                      </button>
                    </div>
                    {filesLoading ? (
                      <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Chargement…</p>
                    ) : (filesIndex?.originals.length ?? 0) === 0 ? (
                      <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Aucun fichier déposé.</p>
                    ) : (
                      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {filesIndex!.originals.map((item) => {
                          const active = selectedOriginalId === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSelectedOriginalId(item.id)}
                              style={{
                                textAlign: 'left',
                                width: '100%',
                                padding: '10px 12px',
                                borderRadius: 8,
                                border: active ? '1px solid rgba(61,255,170,0.28)' : '1px solid rgba(255,255,255,0.06)',
                                background: active ? 'rgba(61,255,170,0.06)' : 'rgba(255,255,255,0.02)',
                                cursor: 'pointer',
                              }}
                            >
                              <div className="flex items-start gap-3">
                                <FileText size={14} style={{ color: active ? '#3dffaa' : '#5ee7ff', flexShrink: 0, marginTop: 2 }} />
                                <div className="flex-1 min-w-0">
                                  <p className="font-mono text-xs truncate" style={{ color: '#e2e8f0' }}>{item.original_name}</p>
                                  <p className="font-mono text-[10px] mt-0.5" style={{ color: '#7a6c9a' }}>
                                    {formatBytes(item.size_bytes)} · {new Date(item.uploaded_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {item.treatments_count} traitement{item.treatments_count > 1 ? 's' : ''}
                                  </p>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {!selectedFileDetail ? (
                    <div style={{ padding: 16, borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                      <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Sélectionne un fichier pour voir son aperçu et son historique.</p>
                    </div>
                  ) : (
                    <>
                      <div style={{ padding: 16, borderRadius: 10, border: '1px solid rgba(61,255,170,0.08)', background: 'rgba(61,255,170,0.03)' }}>
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{selectedFileDetail.original.original_name}</p>
                            <p className="font-mono text-xs mt-1" style={{ color: '#7a6c9a' }}>
                              {selectedFileDetail.original.extension} · {formatBytes(selectedFileDetail.original.size_bytes)} · {new Date(selectedFileDetail.original.uploaded_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                            </p>
                            <p className="font-mono text-xs mt-1" style={{ color: '#7a6c9a' }}>
                              {selectedFileDetail.original.treatments_count} traitement{selectedFileDetail.original.treatments_count > 1 ? 's' : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            <a
                              href={selectedFileDetail.original.download_url}
                              className="font-mono text-xs px-3 py-2 rounded"
                              style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff' }}
                            >
                              Télécharger
                            </a>
                            <button
                              type="button"
                              className="font-mono text-xs px-3 py-2 rounded"
                              style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.18)', color: '#ff4d58' }}
                              onClick={() => void handleDeleteOriginal(selectedFileDetail.original)}
                            >
                              Supprimer
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          {(filesIndex?.competences ?? []).map((competence) => (
                            <button
                              key={competence.id}
                              type="button"
                              disabled={processingOriginalId === selectedFileDetail.original.id}
                              onClick={() => void handleProcessFile(selectedFileDetail.original, competence)}
                              className="font-mono text-xs px-3 py-2 rounded"
                              style={{
                                background: competence.cloud ? 'rgba(245,158,11,0.08)' : 'rgba(61,255,170,0.08)',
                                border: competence.cloud ? '1px solid rgba(245,158,11,0.18)' : '1px solid rgba(61,255,170,0.18)',
                                color: competence.cloud ? '#f59e0b' : '#3dffaa',
                                opacity: processingOriginalId === selectedFileDetail.original.id ? 0.6 : 1,
                              }}
                            >
                              {processingOriginalId === selectedFileDetail.original.id && !competence.cloud ? 'Traitement…' : competence.label}
                            </button>
                          ))}
                        </div>

                        {cloudConfirmation && (
                          <p className="font-mono text-xs mt-3" style={{ color: '#f59e0b' }}>
                            Compétence cloud confirmée : {cloudConfirmation}
                          </p>
                        )}
                      </div>

                      <div style={{ padding: 16, borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                        <p className="font-mono text-xs mb-2" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>APERÇU</p>
                        {selectedFileDetail.preview?.kind === 'spreadsheet' && selectedFileDetail.preview.summary ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {selectedFileDetail.preview.summary.sheets.map(sheet => (
                              <div key={sheet.name} style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <div className="flex items-center justify-between gap-3">
                                  <p className="font-mono text-xs" style={{ color: '#e2e8f0' }}>{sheet.name}</p>
                                  <span className="font-mono text-[10px]" style={{ color: '#7a6c9a' }}>{sheet.rowCount} lignes · {sheet.columnCount} colonnes</span>
                                </div>
                                {sheet.columns.length > 0 && (
                                  <p className="font-mono text-[10px] mt-2" style={{ color: '#5ee7ff', wordBreak: 'break-word' }}>{sheet.columns.join(' · ')}</p>
                                )}
                                {sheet.sampleRows.length > 0 && (
                                  <pre className="font-mono text-[10px] mt-2" style={{ color: '#c0b0e0', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
{sheet.sampleRows.map((row) => row.join(' | ')).join('\n')}
                                  </pre>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <pre className="font-mono text-xs" style={{ color: '#c0b0e0', whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 220, overflow: 'auto' }}>
                            {selectedFileDetail.preview?.text ?? 'Aucun aperçu disponible.'}
                          </pre>
                        )}
                      </div>

                      <div style={{ padding: 16, borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <p className="font-mono text-xs" style={{ color: '#3d3060', letterSpacing: '0.1em' }}>HISTORIQUE ({selectedFileDetail.history.length})</p>
                          <button type="button" className="font-mono text-xs" style={{ color: '#5a4a7a' }} onClick={() => void refreshFiles(selectedFileDetail.original.id)}>
                            <RefreshCw size={10} /> actualiser
                          </button>
                        </div>
                        {selectedFileDetail.history.length === 0 ? (
                          <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Aucun traitement pour ce fichier.</p>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {selectedFileDetail.history.map((result) => (
                              <div key={result.id} style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <div className="flex items-start gap-3">
                                  <div className="flex-1 min-w-0">
                                    <p className="font-mono text-xs truncate" style={{ color: '#e2e8f0' }}>{result.stored_name}</p>
                                    <p className="font-mono text-[10px] mt-0.5" style={{ color: '#7a6c9a' }}>
                                      {result.competence} · {new Date(result.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {formatBytes(result.size_bytes)}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap justify-end">
                                    <a
                                      href={result.download_url}
                                      className="font-mono text-[10px] px-2 py-1 rounded"
                                      style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.18)', color: '#5ee7ff' }}
                                    >
                                      Télécharger
                                    </a>
                                    <button
                                      type="button"
                                      className="font-mono text-[10px] px-2 py-1 rounded"
                                      style={{ background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.18)', color: '#3dffaa' }}
                                      onClick={() => void handleRestoreResult(result)}
                                    >
                                      Restaurer
                                    </button>
                                    <button
                                      type="button"
                                      className="font-mono text-[10px] px-2 py-1 rounded"
                                      style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.18)', color: '#ff4d58' }}
                                      onClick={() => void handleDeleteResult(result)}
                                    >
                                      Supprimer
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {!loading && !error && tab === 'audio' && (
            <div className="px-5 py-4 flex flex-col gap-5">
              {audioError && (
                <div style={{ padding: '8px 12px', background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.2)', borderRadius: 6, fontSize: 12, color: '#ff4d58', fontFamily: 'monospace' }}>
                  {audioError}
                </div>
              )}

              <div>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>DOSSIER LOCAL (musique lo-fi)</p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={audioFolderDraft}
                    onChange={(e) => setAudioFolderDraft(e.target.value)}
                    placeholder="C:\Musique\lofi"
                    className="font-mono text-xs"
                    style={{
                      flex: 1, padding: '8px 10px', borderRadius: 6,
                      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)',
                      color: '#e2e8f0',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void saveAudioFolder()}
                    className="font-mono text-xs px-3 py-2 rounded"
                    style={{ background: 'rgba(94,231,255,0.08)', border: '1px solid rgba(94,231,255,0.2)', color: '#5ee7ff' }}
                  >
                    Enregistrer
                  </button>
                </div>
                <p className="font-mono text-xs mt-1" style={{ color: '#7a6c9a' }}>
                  Fichiers .mp3, .ogg, .wav, .flac — scannés uniquement à l'ouverture du lecteur.
                </p>
              </div>

              <div>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>RADIOS PRÉ-CONFIGURÉES (SomaFM)</p>
                <div className="flex flex-col gap-1">
                  {(audioSettings?.presets ?? []).map(p => (
                    <div key={p.id} className="font-mono text-xs" style={{ color: '#7a6c9a', padding: '4px 0' }}>
                      {p.name}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' }}>FLUX RADIO PERSONNALISÉS</p>
                {(audioSettings?.customStreams ?? []).length === 0 ? (
                  <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Aucun flux ajouté.</p>
                ) : (
                  <div className="flex flex-col gap-2 mb-3">
                    {audioSettings!.customStreams.map((s, i) => (
                      <div key={`${s.url}-${i}`} className="flex items-center justify-between gap-2" style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="min-w-0">
                          <p className="font-mono text-xs truncate" style={{ color: '#e2e8f0' }}>{s.name}</p>
                          <p className="font-mono text-[10px] truncate" style={{ color: '#5a4a7a' }}>{s.url}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeAudioStream(i)}
                          className="font-mono text-xs px-2 py-1 rounded"
                          style={{ background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.18)', color: '#ff4d58', flexShrink: 0 }}
                        >
                          Supprimer
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newStreamName}
                    onChange={(e) => setNewStreamName(e.target.value)}
                    placeholder="Nom"
                    className="font-mono text-xs"
                    style={{ width: 120, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', color: '#e2e8f0' }}
                  />
                  <input
                    type="text"
                    value={newStreamUrl}
                    onChange={(e) => setNewStreamUrl(e.target.value)}
                    placeholder="https://…"
                    className="font-mono text-xs"
                    style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', color: '#e2e8f0' }}
                  />
                  <button
                    type="button"
                    onClick={() => void addAudioStream()}
                    className="font-mono text-xs px-3 py-2 rounded"
                    style={{ background: 'rgba(61,255,170,0.08)', border: '1px solid rgba(61,255,170,0.2)', color: '#3dffaa' }}
                  >
                    Ajouter
                  </button>
                </div>
                <p className="font-mono text-xs mt-2" style={{ color: '#7a6c9a' }}>
                  Utilise uniquement des flux radio publics et librement accessibles (pas de compte requis).
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
