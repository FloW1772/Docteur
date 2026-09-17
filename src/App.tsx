import { agentPageData } from './lib/agent-page';
import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import { Trash2, MoreVertical, Plus, X, Link2, AlertTriangle, RefreshCw, Upload, ListVideo, Eye, Zap, FileText, BookOpen } from 'lucide-react';
import { usePages } from './hooks/usePages';
import { useCortex } from './hooks/useCortex';
import { useModalOpenTracking, useAnyModalOpen } from './hooks/useModalRegistry';
import { useVoiceActivation } from './hooks/useVoiceActivation';
import { useGestureCamera, getGestureSensitivity, setGestureSensitivity, getEasterEggEnabled, setEasterEggEnabled } from './hooks/useGestureCamera';
import { useScreenShare } from './hooks/useScreenShare';
import { speakEasterEgg } from './lib/easterEggVoice';
import VoiceIndicator from './components/layout/VoiceIndicator';
import GestureOverlay from './components/layout/GestureOverlay';
import ShutdownOverlay from './components/layout/ShutdownOverlay';
import { UpdateBanner } from './components/layout/UpdateBanner';
import VisionAnalyzeModal from './components/modals/VisionAnalyzeModal';
import ConversationModal from './components/modals/ConversationModal';
import ScreenShareOverlay from './components/layout/ScreenShareOverlay';
import ScreenCaptureModal from './components/modals/ScreenCaptureModal';
import SearchConsole from './components/console/SearchConsole';
import BackupModal from './components/modals/BackupModal';
import CorpusModal from './components/modals/CorpusModal';
import ActivityLogModal from './components/modals/ActivityLogModal';
import { getCorpusShowIn3D } from './lib/corpusSettings';
import PdfExportModal from './components/modals/PdfExportModal';
// Lazy-loaded: large (3600+ lines), only ever needed once the user opens
// Settings — never on initial load. Batch B (audit finding F9).
const SettingsModal = lazy(() => import('./components/modals/SettingsModal'));
import type { Tab as SettingsTab } from './components/modals/SettingsModal';
import DownloadModal, { type DownloadResult } from './components/modals/DownloadModal';
import HelpModal from './components/modals/HelpModal';
import RoadmapModal from './components/modals/RoadmapModal';
import AgentsModal   from './components/modals/AgentsModal';
import VideoSummaryModal from './components/modals/VideoSummaryModal';
import SkillsModal   from './components/modals/SkillsModal';
import PromptGeneratorModal from './components/modals/PromptGeneratorModal';
import TeacherModal from './components/modals/TeacherModal';
// Lazy-loaded: not needed on initial load, opened only from Settings/toolbar
// actions the user may never use in a given session. Batch B (finding F9).
const NotebookModal = lazy(() => import('./components/modals/NotebookModal'));
const ImageGeneratorModal = lazy(() => import('./components/modals/ImageGeneratorModal'));
const MetaGptStudioModal = lazy(() => import('./components/modals/MetaGptStudioModal'));
import KiwixLibraryModal from './components/modals/KiwixLibraryModal';
import CvFreeQuestionModal from './components/modals/CvFreeQuestionModal';
import AudioPlayer from './components/layout/AudioPlayer';
import TodoPanel     from './components/panels/TodoPanel';
import BatchProgressModal, { type BatchProgressState, type QueuedJob } from './components/modals/BatchProgressModal';
import ConfirmBatchModal from './components/modals/ConfirmBatchModal';
import TopBar from './components/layout/TopBar';
import Sidebar from './components/layout/Sidebar';
import NeuralBrain from './components/neural/NeuralBrain';
import BlockComp from './components/blocks/Block';
import ReadingView from './components/reading/ReadingView';
import PromptMeta from './components/neural/PromptMeta';
import ResummariseModal from './components/modals/ResummariseModal';
import CompareModal     from './components/modals/CompareModal';
import type { Page, PageKind, Block } from './lib/types';
import { KIND_META } from './lib/types';
import { generateId } from './lib/generateId';
import { cortexClient, onConnectionError, DETAIL_LEVEL_LABELS } from './lib/cortex/client';
import type { CaptureNeuron, CaptureResult, DeepCaptureResult, PlaylistInfo, WhisperProgress, WhisperStats, DeepResearchOptions, VoiceSettings, TodoItem, BackupExport, DetailLevel, ResearchSource } from './lib/cortex/client';
import { pageToContent } from './lib/cortex/pageToContent';
import { savePage } from './lib/storage';
import { useMobile } from './lib/useMobile';

// ─── Lazy modal loading fallback ───────────────────────────────────────────
// Shown for the brief moment (typically well under a second on a local
// network) between opening a lazy-loaded modal and its code chunk arriving.
// Batch B (audit finding F9) — SettingsModal/NotebookModal/ImageGeneratorModal.

function LazyModalFallback() {
  return (
    <div className="modal-backdrop">
      <div className="flex items-center justify-center" style={{ minHeight: 120 }}>
        <RefreshCw size={20} className="animate-spin" style={{ color: '#5ee7ff' }} />
      </div>
    </div>
  );
}

// ─── Confirm Delete Modal ─────────────────────────────────────────────────────

function ConfirmDeleteModal({
  page,
  onConfirm,
  onCancel,
}: {
  page: Page;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box modal-delete" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <AlertTriangle size={20} style={{ color: '#ff4d58', flexShrink: 0 }} />
          <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
            Supprimer ce neurone ?
          </h3>
        </div>
        <p className="font-mono text-sm mb-6" style={{ color: '#8070a8', lineHeight: 1.6 }}>
          Le neurone{' '}
          <span className="font-semibold" style={{ color: '#e8d9ff' }}>
            &ldquo;{page.title || 'Sans titre'}&rdquo;
          </span>{' '}
          et toutes ses synapses seront définitivement supprimés.
          <br />
          <span style={{ color: '#5a4a7a', fontSize: 11 }}>Cette action est irréversible.</span>
        </p>
        <div className="flex gap-3 justify-end">
          <button className="modal-btn-cancel font-mono text-sm" onClick={onCancel} autoFocus>
            Annuler
          </button>
          <button
            className="modal-btn-delete font-mono text-sm flex items-center gap-2"
            onClick={onConfirm}
          >
            <Trash2 size={13} />
            Supprimer
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Link Picker Modal ────────────────────────────────────────────────────────

function LinkPickerModal({
  currentPageId,
  pages,
  onSelect,
  onClose,
}: {
  currentPageId: string;
  pages: Page[];
  onSelect: (targetId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentPage   = pages.find(p => p.id === currentPageId);
  const alreadyLinked = new Set(currentPage?.links ?? []);
  const available     = pages.filter(
    p => p.id !== currentPageId &&
      !alreadyLinked.has(p.id) &&
      (!search || p.title.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box modal-link-picker" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(61,255,170,0.1)' }}>
          <Link2 size={14} style={{ color: '#3dffaa', flexShrink: 0 }} />
          <span className="font-mono text-xs" style={{ color: '#a09acc', letterSpacing: '0.1em' }}>
            LIER À UN NEURONE
          </span>
          <button type="button" className="ml-auto" style={{ color: '#5a4a7a' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-2" style={{ borderBottom: '1px solid rgba(61,255,170,0.08)' }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Rechercher un neurone…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="modal-search w-full"
          />
        </div>
        <div className="modal-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {available.length === 0 ? (
            <p className="font-mono text-xs px-4 py-4" style={{ color: '#5a4a7a' }}>
              {pages.length <= 1 ? 'Aucun autre neurone disponible' : 'Aucun résultat'}
            </p>
          ) : (
            available.map(p => {
              const meta = KIND_META[p.kind];
              return (
                <button
                  key={p.id}
                  type="button"
                  className="modal-list-item w-full flex items-center gap-3 px-4 py-2 text-left"
                  onClick={() => { onSelect(p.id); onClose(); }}
                >
                  <span style={{ color: meta.color, fontSize: 14 }}>{meta.icon}</span>
                  <span className="font-mono text-xs flex-1 truncate" style={{ color: '#c0b0e0' }}>
                    {p.title || 'Sans titre'}
                  </span>
                  <span className="font-mono" style={{ color: '#3d3060', fontSize: 10 }}>{meta.label}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Reindex Modal ────────────────────────────────────────────────────────────

function ReindexModal({
  total,
  progress,
  onConfirm,
  onClose,
  running,
}: {
  total: number;
  progress: number;
  onConfirm: () => void;
  onClose: () => void;
  running: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !running) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal-box modal-delete" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <RefreshCw size={18} style={{ color: '#5ee7ff', flexShrink: 0 }} />
          <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
            Ré-indexer tous les neurones
          </h3>
        </div>

        {!running ? (
          <>
            <p className="font-mono text-sm mb-6" style={{ color: '#8070a8', lineHeight: 1.6 }}>
              Tous les {total} neurones seront ré-indexés dans le cortex cognitif.
              <br />
              <span style={{ color: '#5a4a7a', fontSize: 11 }}>
                Utile après une mise à jour du modèle d'embedding.
              </span>
            </p>
            <div className="flex gap-3 justify-end">
              <button type="button" className="modal-btn-cancel font-mono text-sm" onClick={onClose}>
                Annuler
              </button>
              <button
                type="button"
                className="font-mono text-sm flex items-center gap-2 px-4 py-2 rounded"
                style={{
                  background: 'rgba(94,231,255,0.1)',
                  border:     '1px solid rgba(94,231,255,0.3)',
                  color:      '#5ee7ff',
                  cursor:     'pointer',
                }}
                onClick={onConfirm}
              >
                <RefreshCw size={13} />
                Lancer la ré-indexation
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="font-mono text-xs mb-3" style={{ color: '#7a6c9a' }}>
              Indexation en cours…
            </p>
            {/* Progress bar */}
            <div
              className="rounded-full overflow-hidden mb-2"
              style={{ height: 6, background: 'rgba(94,231,255,0.1)' }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width:      `${pct}%`,
                  background: 'linear-gradient(90deg, #3dffaa, #5ee7ff)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <p className="font-mono text-xs" style={{ color: '#5ee7ff' }}>
              {progress} / {total} neurones indexés
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [onDismiss, message]);

  return (
    <div className="toast" onClick={onDismiss}>
      {message}
    </div>
  );
}

// ─── Capture Modal ───────────────────────────────────────────────────────────

function CaptureModal({
  value,
  busy,
  capturePhase,
  onChange,
  onSubmit,
  onClose,
  onCancelDeep,
  onImagePaste,
  pendingImages,
  onRemoveImage,
}: {
  value: string;
  busy: boolean;
  capturePhase: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onCancelDeep: () => void;
  onImagePaste?: (file: File) => void;
  pendingImages?: Array<{ id: string; previewUrl: string }>;
  onRemoveImage?: (id: string) => void;
}) {
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const deepMatch   = parseDeepInput(value);
  const isDeep      = deepMatch !== null;
  const isPaste     = deepMatch?.mode === 'paste';
  const urlCount    = deepMatch?.mode === 'urls' ? deepMatch.urls.length : 0;
  const isBatch     = urlCount > 1;
  const isRunning   = busy && capturePhase !== null;

  useEffect(() => {
    if (!isRunning) inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { isRunning ? onCancelDeep() : onClose(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) {
        e.preventDefault();
        onSubmit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, isRunning, onClose, onSubmit, onCancelDeep]);

  return (
    <div
      className="modal-backdrop"
      style={{ background: 'rgba(15, 12, 25, 0.95)', backdropFilter: 'blur(18px)' }}
      onClick={isRunning ? undefined : (busy ? undefined : onClose)}
    >
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(480px, calc(100vw - 24px))',
          border: `1px solid ${isDeep ? 'rgba(167,139,250,0.4)' : 'rgba(255, 139, 61, 0.3)'}`,
          borderRadius: 12,
          padding: 20,
          boxShadow: '0 30px 90px rgba(0, 0, 0, 0.56)',
        }}
      >
        <div className="flex items-center gap-3 mb-4">
          <Upload size={18} style={{ color: isDeep ? '#a78bfa' : '#ff8b3d', flexShrink: 0 }} />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
                Capture rapide
              </h3>
              {isDeep && (
                <span
                  className="font-mono"
                  style={{
                    fontSize: 9, letterSpacing: '0.1em', padding: '1px 6px',
                    borderRadius: 4, background: 'rgba(167,139,250,0.15)',
                    border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa',
                  }}
                >
                  {isPaste ? 'TEXTE COLLÉ' : 'PROFONDE'}
                </span>
              )}
            </div>
            <p className="font-mono text-xs mt-0.5" style={{ color: '#9f8fbf' }}>
              {isPaste
                ? 'Texte collé — analyse IA sans scraping'
                : isBatch
                  ? `${urlCount} liens détectés — traitement séquentiel`
                  : isDeep
                    ? 'Extraction + analyse IA — 15 à 60 secondes'
                    : 'Colle une URL ou du texte brut, puis valide avec Ctrl+Entrée'}
            </p>
          </div>
        </div>

        {/* Progress view when deep capture is running */}
        {isRunning ? (
          <div className="flex flex-col items-center gap-4 py-6">
            <div
              className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: 'rgba(167,139,250,0.3)', borderTopColor: '#a78bfa' }}
            />
            <p className="font-mono text-sm text-center px-2" style={{ color: '#c4b5fd', lineHeight: 1.5 }}>
              {capturePhase}
            </p>
            <button
              type="button"
              aria-label="Annuler la capture"
              className="font-mono text-xs px-4 py-1.5 rounded"
              style={{ background: 'rgba(255,77,88,0.1)', border: '1px solid rgba(255,77,88,0.2)', color: '#ff4d58', cursor: 'pointer' }}
              onClick={onCancelDeep}
            >
              Annuler
            </button>
          </div>
        ) : (
          <>
            <textarea
              ref={inputRef}
              value={value}
              onChange={e => onChange(e.target.value)}
              onPaste={e => {
                if (!onImagePaste) return;
                const items = Array.from(e.clipboardData.items);
                const imgItem = items.find(it => it.kind === 'file' && it.type.startsWith('image/'));
                if (!imgItem) return;
                e.preventDefault();
                const file = imgItem.getAsFile();
                if (file) onImagePaste(file);
              }}
              placeholder="info https://... · veille https://... · ou colle directement une URL / du texte"
              className="modal-search w-full"
              style={{
                minHeight: 160,
                resize: 'vertical',
                padding: 14,
                borderRadius: 10,
                border: `1px solid ${isDeep ? 'rgba(167,139,250,0.2)' : 'rgba(255, 139, 61, 0.16)'}`,
                background: 'rgba(8, 6, 16, 0.78)',
                lineHeight: 1.6,
              }}
            />

            {/* Pending images strip */}
            {pendingImages && pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {pendingImages.map(img => (
                  <div key={img.id} style={{ position: 'relative', display: 'inline-block' }}>
                    <img
                      src={img.previewUrl}
                      alt="Image en attente"
                      style={{
                        width: 72, height: 72, objectFit: 'cover',
                        borderRadius: 6, border: '1px solid rgba(255,139,61,0.35)',
                        display: 'block',
                      }}
                    />
                    <button
                      type="button"
                      aria-label="Retirer cette image"
                      onClick={() => onRemoveImage?.(img.id)}
                      style={{
                        position: 'absolute', top: -7, right: -7,
                        width: 18, height: 18, borderRadius: '50%',
                        background: 'rgba(255,77,88,0.92)',
                        border: '1px solid rgba(255,77,88,0.5)',
                        cursor: 'pointer', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontSize: 12, lineHeight: 1, padding: 0,
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 mt-4">
              <button type="button" className="modal-btn-cancel font-mono text-sm" onClick={onClose} disabled={busy}>
                Annuler
              </button>
              <button
                type="button"
                className="modal-btn-delete font-mono text-sm flex items-center gap-2"
                onClick={onSubmit}
                disabled={busy || (!value.trim() && (!pendingImages || pendingImages.length === 0))}
                style={{
                  background:   isDeep ? 'rgba(167,139,250,0.12)' : 'rgba(61, 255, 170, 0.12)',
                  borderColor:  isDeep ? 'rgba(167,139,250,0.36)' : 'rgba(61, 255, 170, 0.36)',
                  color:        isDeep ? '#a78bfa' : '#3dffaa',
                }}
              >
                <Upload size={13} />
                {busy
                  ? 'Capture...'
                  : pendingImages && pendingImages.length > 0 && !isDeep
                    ? `Créer (${pendingImages.length} image${pendingImages.length > 1 ? 's' : ''}${value.trim() ? ' + texte' : ''})`
                    : isPaste ? 'Analyser le texte'
                    : isBatch ? `Analyser ${urlCount} liens`
                    : isDeep ? 'Analyse profonde'
                    : 'Capturer'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Conflict Modal ──────────────────────────────────────────────────────────

type ConflictChoice = 'reuse' | 'create_new' | 'cancel';

function ConflictModal({
  existingNeuron,
  proposedParent,
  onChoose,
}: {
  existingNeuron: Page;
  proposedParent: CaptureNeuron;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const firstButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstButtonRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onChoose('cancel');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose]);

  return (
    <div
      className="modal-backdrop"
      style={{ background: 'rgba(15, 12, 25, 0.95)', backdropFilter: 'blur(18px)' }}
      onClick={() => onChoose('cancel')}
    >
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(480px, calc(100vw - 24px))',
          border: '1px solid rgba(255, 139, 61, 0.3)',
          borderRadius: 12,
          padding: 20,
          boxShadow: '0 30px 90px rgba(0, 0, 0, 0.56)',
        }}
      >
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={18} style={{ color: '#ff8b3d', flexShrink: 0, marginTop: 1 }} />
          <div>
            <h3 className="font-grotesk font-semibold text-base" style={{ color: '#f0eaff' }}>
              Conflit de neurone
            </h3>
            <p className="font-mono text-sm mt-2" style={{ color: '#b3a4d6', lineHeight: 1.55 }}>
              Un neurone nommé &ldquo;{proposedParent.title}&rdquo; existe déjà (kind: {existingNeuron.kind}). Que veux-tu faire ?
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button
            ref={firstButtonRef}
            type="button"
            className="font-mono text-sm px-4 py-3 rounded"
            style={{
              background: 'rgba(61,255,170,0.14)',
              border: '1px solid rgba(61,255,170,0.26)',
              color: '#3dffaa',
              textAlign: 'left',
            }}
            onClick={() => onChoose('reuse')}
          >
            Utiliser l'existant comme parent
          </button>
          <button
            type="button"
            className="font-mono text-sm px-4 py-3 rounded"
            style={{
              background: 'rgba(94,231,255,0.12)',
              border: '1px solid rgba(94,231,255,0.24)',
              color: '#5ee7ff',
              textAlign: 'left',
            }}
            onClick={() => onChoose('create_new')}
          >
            Créer un nouveau neurone ({proposedParent.title} - chaîne)
          </button>
          <button
            type="button"
            className="font-mono text-sm px-4 py-3 rounded"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#9f8fbf',
              textAlign: 'left',
            }}
            onClick={() => onChoose('cancel')}
          >
            Annuler la capture
          </button>
        </div>
      </div>
    </div>
  );
}

function createContentBlocks(content: string, fallbackTitle: string): Block[] {
  const normalized = content.trim() || fallbackTitle.trim() || 'Nouvelle note';
  return [
    {
      id: generateId(),
      type: 'paragraph',
      content: normalized,
    },
  ];
}

function normalizeTitle(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function captureWarnsLimited(result: CaptureResult): boolean {
  const capture = (result.child.metadata as { capture?: Record<string, unknown> } | undefined)?.capture ?? {};
  return capture.status === 'limited' || capture.warning === 'parent_not_identified';
}

const DEEP_PREFIX    = /^(info|veille|analyse|resume)\s+([\s\S]+)/i;
const DOWNLOAD_PREFIX = /^(?:download|telecharge|télécharge|dl)\s+(https?:\/\/\S+)/i;
const CHAINE_RE      = /^chaine\s+(https?:\/\/[^\s]+)/i;

// YouTube channel URL patterns: /@nom, /channel/UCxxx, /c/nom, /user/nom
// with optional tab suffixes (/videos, /featured, /about, /shorts, /streams …)
const YT_CHANNEL_ROOT  = /^\/((@[^/?#/][^/?#]*)|(channel\/[^/?#]+)|(c\/[^/?#]+)|(user\/[^/?#]+))/;
const YT_TAB_SUFFIX    = /\/(videos|featured|about|shorts|streams|playlists|community)\/?$/;
// Paths that are definitely NOT channel roots
const YT_NON_CHANNEL   = /^\/(watch|playlist|shorts\/[^/]+|embed\/|results|feed\/|yts\/)/;

function detectChannelUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const chaineMatch = trimmed.match(CHAINE_RE);
  if (chaineMatch) {
    try { new URL(chaineMatch[1]); return chaineMatch[1]; } catch { return null; }
  }
  try {
    const u = new URL(trimmed);
    if (!u.hostname.includes('youtube.com')) return null;
    const p = u.pathname;
    if (YT_NON_CHANNEL.test(p)) return null;
    // Must start with a channel root pattern
    if (!YT_CHANNEL_ROOT.test(p)) return null;
    // Strip query, accept bare root or root + known tab suffix
    const bare = p.replace(YT_TAB_SUFFIX, '').replace(/\/$/, '');
    if (!YT_CHANNEL_ROOT.test(bare)) return null;
    return trimmed;
  } catch { return null; }
}

// Pure string URL extraction — never evaluated as code, only .match()
function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s]+/g) ?? [];
}

type DeepMatch =
  | { mode: 'urls';     urls: string[] }
  | { mode: 'paste';    source: string; url?: string; text: string }
  | { mode: 'download'; url: string };

function detectPlaylistUrl(raw: string): { type: 'pure' | 'mixed'; playlistUrl: string } | null {
  try {
    const u = new URL(raw.trim());
    const isYT = u.hostname.includes('youtube.com') || u.hostname === 'youtu.be';
    if (!isYT) return null;
    const listId = u.searchParams.get('list');
    if (!listId) return null;
    const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
    const isPure = u.pathname === '/playlist';
    return { type: isPure ? 'pure' : 'mixed', playlistUrl };
  } catch {
    return null;
  }
}

function parseDeepInput(raw: string): DeepMatch | null {
  const trimmed = raw.trim();

  // Download prefix takes priority
  const dl = trimmed.match(DOWNLOAD_PREFIX);
  if (dl) return { mode: 'download', url: dl[1] };

  const m = trimmed.match(DEEP_PREFIX);

  if (m) {
    const rest = m[2]; // everything after "info/veille/etc "

    // First token determines mode.
    // MUST check this before newline to avoid routing URL batches to paste mode.
    const firstToken = rest.trimStart().split(/[\s\n]/)[0] ?? '';
    if (/^https?:\/\//i.test(firstToken)) {
      // URL batch mode: extract all URLs as pure strings, no evaluation
      const urls = extractUrls(rest);
      if (urls.length === 0) return null;
      return { mode: 'urls', urls };
    }

    // First token is NOT a URL → paste mode (source name + article text after newline)
    const nlIdx = rest.indexOf('\n');
    if (nlIdx !== -1) {
      const pastedText = rest.slice(nlIdx + 1).trim();
      if (pastedText) {
        const firstLine  = rest.slice(0, nlIdx).trim();
        const urlInLine  = firstLine.match(/https?:\/\/[^\s]+/)?.[0];
        const source     = firstLine.replace(urlInLine ?? '', '').trim() || 'web';
        return { mode: 'paste', source, url: urlInLine, text: pastedText };
      }
    }

    return null;
  }

  // No keyword prefix — detect raw URL batch (multiple https:// lines pasted directly)
  const urls = extractUrls(trimmed);
  if (urls.length >= 2) {
    return { mode: 'urls', urls };
  }

  return null;
}

// ─── CV PDF Import Modal ──────────────────────────────────────────────────────

function CvPdfImportModal({ onImport, onClose }: {
  onImport: (file: File) => Promise<void>;
  onClose:  () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handle(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('Le fichier doit être un PDF (.pdf)');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Fichier trop volumineux (max 10 Mo)');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await onImport(file);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur lors de l\'import');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void handle(file);
  }

  const zone: React.CSSProperties = {
    border:       `2px dashed ${dragging ? '#f472b6' : error ? '#ff4d58' : 'rgba(244,114,182,0.3)'}`,
    borderRadius: 10,
    padding:      '32px 24px',
    display:      'flex',
    flexDirection: 'column',
    alignItems:   'center',
    gap:          12,
    background:   dragging ? 'rgba(244,114,182,0.06)' : 'rgba(255,255,255,0.02)',
    transition:   'all 0.15s',
    cursor:       busy ? 'default' : 'pointer',
  };

  return (
    <div className="modal-backdrop" style={{ background: 'rgba(15,12,25,0.95)', backdropFilter: 'blur(18px)' }} onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 460, padding: '28px 28px 24px', borderRadius: 14, border: '1px solid rgba(244,114,182,0.15)', background: '#130f1e' }}>

        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 style={{ fontSize: 15, fontFamily: 'monospace', color: '#f472b6', fontWeight: 600, margin: 0 }}>Importer un CV depuis un PDF</h2>
            <p style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', margin: '3px 0 0' }}>
              🔒 Traitement 100% local · aucune donnée envoyée au cloud
            </p>
          </div>
          <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        <div
          style={zone}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => { if (!busy) fileRef.current?.click(); }}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
          aria-label="Zone de dépôt PDF"
        >
          <span style={{ fontSize: 32, lineHeight: 1 }}>{busy ? '⏳' : '📄'}</span>
          <p style={{ fontSize: 12, fontFamily: 'monospace', color: '#c0b0e0', textAlign: 'center', margin: 0 }}>
            {busy ? 'Extraction du texte en cours…' : 'Glisse un fichier PDF ici'}
          </p>
          {!busy && (
            <button
              type="button"
              style={{
                fontSize: 11, fontFamily: 'monospace', padding: '6px 14px', borderRadius: 6,
                background: 'rgba(244,114,182,0.12)', border: '1px solid rgba(244,114,182,0.3)',
                color: '#f472b6', cursor: 'pointer',
              }}
              onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
            >
              Choisir un fichier
            </button>
          )}
          <p style={{ fontSize: 10, color: '#5a4a7a', fontFamily: 'monospace', margin: 0 }}>PDF · max 10 Mo · texte sélectionnable requis</p>
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.2)' }}>
            <p style={{ fontSize: 11, fontFamily: 'monospace', color: '#ff6b75', margin: 0 }}>⚠ {error}</p>
            {error.includes('scanné') && (
              <p style={{ fontSize: 10, fontFamily: 'monospace', color: '#7a6c9a', margin: '6px 0 0' }}>
                → Crée un neurone CV vide et colle le texte manuellement.
              </p>
            )}
          </div>
        )}

        <input ref={fileRef} type="file" accept=".pdf,application/pdf" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) void handle(f); }} />
      </div>
    </div>
  );
}

// ─── CV Rewrite Modal ─────────────────────────────────────────────────────────

function CvRewriteModal({
  sourcePage,
  onRewrite,
  onClose,
}: {
  sourcePage: Page;
  onRewrite:  (opts: { targetJob?: string; jobOffer?: string; powerful?: boolean }) => Promise<void>;
  onClose:    () => void;
}) {
  const [targeted,  setTargeted]  = useState(false);
  const [targetJob, setTargetJob] = useState('');
  const [jobOffer,  setJobOffer]  = useState('');
  const [powerful,  setPowerful]  = useState(false);
  const [busy,      setBusy]      = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit() {
    setBusy(true);
    try {
      await onRewrite({
        targetJob: targeted ? targetJob.trim() || undefined : undefined,
        jobOffer:  targeted ? jobOffer.trim()  || undefined : undefined,
        powerful,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const inp: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, padding: '6px 10px', color: '#e2d9f3', fontSize: 12, fontFamily: 'monospace', outline: 'none',
  };
  const tog = (on: boolean): React.CSSProperties => ({
    flex: 1, padding: '5px 10px', fontSize: 11, fontFamily: 'monospace', borderRadius: 5, cursor: 'pointer',
    background: on ? 'rgba(244,114,182,0.18)' : 'rgba(255,255,255,0.04)',
    border: on ? '1px solid rgba(244,114,182,0.5)' : '1px solid rgba(255,255,255,0.08)',
    color: on ? '#f472b6' : '#7a6c9a',
  });

  return (
    <div className="modal-backdrop" style={{ background: 'rgba(15,12,25,0.95)', backdropFilter: 'blur(18px)' }} onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 500, padding: '28px 28px 24px', borderRadius: 14, border: '1px solid rgba(244,114,182,0.15)', background: '#130f1e' }}>

        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 style={{ fontSize: 15, fontFamily: 'monospace', color: '#f472b6', fontWeight: 600, margin: 0 }}>Réécrire le CV</h2>
            <p style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', margin: '3px 0 0' }}>
              🔒 100% local · original conservé · nouveau neurone créé
            </p>
          </div>
          <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <p style={{ fontSize: 11, fontFamily: 'monospace', color: '#5a4a7a', marginBottom: 14 }}>
          Source : <span style={{ color: '#c0b0e0' }}>{sourcePage.title}</span>
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>MODE</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={tog(!targeted)} onClick={() => setTargeted(false)}>Générique</button>
              <button type="button" style={tog(targeted)}  onClick={() => setTargeted(true)}>Ciblée (poste / offre)</button>
            </div>
          </div>

          {targeted && (
            <>
              <div>
                <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>POSTE VISÉ</label>
                <input
                  type="text"
                  value={targetJob}
                  onChange={e => setTargetJob(e.target.value)}
                  placeholder="Ex : Responsable logistique, Développeur backend…"
                  style={inp}
                  autoFocus
                />
              </div>
              <div>
                <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>
                  OFFRE D'EMPLOI <span style={{ opacity: 0.5 }}>(optionnel — colle le texte brut)</span>
                </label>
                <textarea
                  value={jobOffer}
                  onChange={e => setJobOffer(e.target.value)}
                  placeholder="Colle ici le texte de l'offre pour une réécriture précisément alignée…"
                  rows={5}
                  style={{ ...inp, resize: 'vertical' }}
                />
              </div>
            </>
          )}

          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p style={{ fontSize: 10, fontFamily: 'monospace', color: '#5a4a7a', marginBottom: 8 }}>CE QUE LA RÉÉCRITURE FAIT</p>
            <ul style={{ fontSize: 10, fontFamily: 'monospace', color: '#7a6c9a', margin: 0, padding: '0 0 0 14px', lineHeight: 1.7 }}>
              <li>Tâches → réalisations avec verbes d'action forts</li>
              <li>Informations manquantes → marqueurs <span style={{ color: '#f59e0b' }}>[A COMPLETER : ...]</span></li>
              <li>Suppression des formulations creuses et clichés</li>
              <li>Section avant/après des changements effectués</li>
              {targeted && <li style={{ color: '#f472b6' }}>Réordonne selon le poste, reprend les mots-clés de l'offre</li>}
            </ul>
          </div>

          <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={powerful} onChange={e => setPowerful(e.target.checked)} />
            Modèle puissant (configurable dans Réglages) — résultat plus fin, plus lent
          </label>

          <button
            type="button"
            disabled={busy}
            onClick={() => { void handleSubmit(); }}
            style={{
              width: '100%', padding: '10px 0', fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
              borderRadius: 8, cursor: busy ? 'default' : 'pointer', marginTop: 4,
              background: busy ? 'rgba(244,114,182,0.08)' : 'rgba(244,114,182,0.15)',
              border: '1px solid rgba(244,114,182,0.4)', color: busy ? '#f472b699' : '#f472b6',
            }}
          >
            {busy ? '⏳ Réécriture en cours…' : '✦ Réécrire le CV'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CV Adapt Modal ───────────────────────────────────────────────────────────

function CvAdaptModal({
  sourcePage,
  onAdapt,
  onClose,
}: {
  sourcePage: Page;
  onAdapt:    (opts: { jobOffer: string; powerful?: boolean }) => Promise<void>;
  onClose:    () => void;
}) {
  const [jobOffer,  setJobOffer]  = useState('');
  const [powerful,  setPowerful]  = useState(false);
  const [busy,      setBusy]      = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit() {
    if (!jobOffer.trim()) return;
    setBusy(true);
    try { await onAdapt({ jobOffer: jobOffer.trim(), powerful }); onClose(); }
    finally { setBusy(false); }
  }

  const inp: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, padding: '6px 10px', color: '#e2d9f3', fontSize: 12, fontFamily: 'monospace', outline: 'none',
  };

  return (
    <div className="modal-backdrop" style={{ background: 'rgba(15,12,25,0.95)', backdropFilter: 'blur(18px)' }} onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 520, padding: '28px 28px 24px', borderRadius: 14, border: '1px solid rgba(244,114,182,0.15)', background: '#130f1e' }}>

        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontSize: 15, fontFamily: 'monospace', color: '#f472b6', fontWeight: 600, margin: 0 }}>Adapter à une offre</h2>
            <p style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', margin: '3px 0 0' }}>
              🔒 100% local · CV source conservé · nouveau neurone créé
            </p>
          </div>
          <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <p style={{ fontSize: 11, fontFamily: 'monospace', color: '#5a4a7a', marginBottom: 14 }}>
          CV source : <span style={{ color: '#c0b0e0' }}>{sourcePage.title}</span>
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>
              OFFRE D'EMPLOI <span style={{ color: '#ff4d58' }}>*</span>
              <span style={{ opacity: 0.5, marginLeft: 6 }}>(colle le texte brut de l'offre)</span>
            </label>
            <textarea
              value={jobOffer}
              onChange={e => setJobOffer(e.target.value)}
              placeholder="Colle ici le texte complet de l'offre d'emploi…"
              rows={8}
              style={{ ...inp, resize: 'vertical' }}
              autoFocus
            />
          </div>

          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p style={{ fontSize: 10, fontFamily: 'monospace', color: '#5a4a7a', marginBottom: 6 }}>CE QUE L'ADAPTATION PRODUIT</p>
            <ul style={{ fontSize: 10, fontFamily: 'monospace', color: '#7a6c9a', margin: 0, padding: '0 0 0 14px', lineHeight: 1.7 }}>
              <li>Score d'adéquation réaliste (sur 100)</li>
              <li>CV réordonné et reformulé avec les mots-clés de l'offre</li>
              <li>Liste de ce qui manque pour ce poste</li>
              <li>Informations manquantes → marqueurs <span style={{ color: '#f59e0b' }}>[A COMPLETER : ...]</span></li>
            </ul>
          </div>

          <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={powerful} onChange={e => setPowerful(e.target.checked)} />
            Modèle puissant (configurable dans Réglages) — résultat plus précis, plus lent
          </label>

          <button
            type="button"
            disabled={busy || !jobOffer.trim()}
            onClick={() => { void handleSubmit(); }}
            style={{
              width: '100%', padding: '10px 0', fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
              borderRadius: 8, cursor: busy || !jobOffer.trim() ? 'default' : 'pointer', marginTop: 4,
              background: busy || !jobOffer.trim() ? 'rgba(244,114,182,0.05)' : 'rgba(244,114,182,0.15)',
              border: '1px solid rgba(244,114,182,0.4)',
              color: busy || !jobOffer.trim() ? '#f472b650' : '#f472b6',
            }}
          >
            {busy ? '⏳ Adaptation en cours…' : '✦ Adapter le CV à l\'offre'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Candidature Letter Modal ─────────────────────────────────────────────────

function CandidatureLetterModal({
  cvPages,
  initialCvId,
  prefillContext,
  onGenerate,
  onClose,
}: {
  cvPages:        Page[];
  initialCvId:    string;
  prefillContext?: string;
  onGenerate:     (params: { cvPageId: string; format: 'email' | 'lettre'; mode: 'generique' | 'ciblee'; company?: string; jobTitle?: string; jobOffer?: string; powerful: boolean }) => Promise<void>;
  onClose:        () => void;
}) {
  const [cvId,     setCvId]     = useState(initialCvId);
  const [format,   setFormat]   = useState<'email' | 'lettre'>('email');
  const [mode,     setMode]     = useState<'generique' | 'ciblee'>('generique');
  const [company,  setCompany]  = useState('');
  const [jobTitle, setJobTitle] = useState(prefillContext ?? '');
  const [jobOffer, setJobOffer] = useState('');
  const [powerful, setPowerful] = useState(false);
  const [busy,     setBusy]     = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit() {
    setBusy(true);
    try {
      await onGenerate({ cvPageId: cvId, format, mode, company: company || undefined, jobTitle: jobTitle || undefined, jobOffer: jobOffer || undefined, powerful });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, padding: '6px 10px', color: '#e2d9f3', fontSize: 12, fontFamily: 'monospace', outline: 'none',
  };
  const toggleBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '5px 10px', fontSize: 11, fontFamily: 'monospace', borderRadius: 5, cursor: 'pointer',
    background: active ? 'rgba(251,191,36,0.18)' : 'rgba(255,255,255,0.04)',
    border: active ? '1px solid rgba(251,191,36,0.5)' : '1px solid rgba(255,255,255,0.08)',
    color: active ? '#fbbf24' : '#7a6c9a',
  });

  return (
    <div className="modal-backdrop" style={{ background: 'rgba(15,12,25,0.95)', backdropFilter: 'blur(18px)' }} onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 480, padding: '28px 28px 24px', borderRadius: 14, border: '1px solid rgba(251,191,36,0.15)', background: '#130f1e' }}>

        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 style={{ fontSize: 15, fontFamily: 'monospace', color: '#fbbf24', fontWeight: 600, margin: 0 }}>✉ Générer une lettre</h2>
            <p style={{ fontSize: 10, color: '#f472b6', fontFamily: 'monospace', margin: '3px 0 0', opacity: 0.85 }}>🔒 100% local — aucune donnée ne quitte cet appareil</p>
          </div>
          <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {cvPages.length > 1 && (
            <div>
              <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>CV SOURCE</label>
              <select value={cvId} onChange={e => setCvId(e.target.value)} style={inputStyle}>
                {cvPages.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
          )}

          <div>
            <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>FORMAT</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={toggleBtn(format === 'email')} onClick={() => setFormat('email')}>Mail court</button>
              <button type="button" style={toggleBtn(format === 'lettre')} onClick={() => setFormat('lettre')}>Lettre classique</button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>MODE</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={toggleBtn(mode === 'generique')} onClick={() => setMode('generique')}>Générique</button>
              <button type="button" style={toggleBtn(mode === 'ciblee')} onClick={() => setMode('ciblee')}>Ciblée</button>
            </div>
          </div>

          {mode === 'ciblee' && (
            <>
              <div>
                <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>ENTREPRISE</label>
                <input type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Nom de l'entreprise" style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>POSTE VISÉ</label>
                <input type="text" value={jobTitle} onChange={e => setJobTitle(e.target.value)} placeholder="Intitulé du poste" style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>OFFRE D'EMPLOI <span style={{ opacity: 0.5 }}>(optionnel)</span></label>
                <textarea value={jobOffer} onChange={e => setJobOffer(e.target.value)} placeholder="Colle le texte de l'offre ici…" rows={4}
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
            </>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={powerful} onChange={e => setPowerful(e.target.checked)} />
              Modèle puissant (configurable dans Réglages) — plus lent
            </label>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => { void handleSubmit(); }}
            style={{
              width: '100%', padding: '10px 0', fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
              borderRadius: 8, cursor: busy ? 'default' : 'pointer', marginTop: 4,
              background: busy ? 'rgba(251,191,36,0.08)' : 'rgba(251,191,36,0.15)',
              border: '1px solid rgba(251,191,36,0.4)', color: busy ? '#fbbf2499' : '#fbbf24',
            }}
          >
            {busy ? '⏳ Génération en cours…' : '✉ Générer'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page Editor ──────────────────────────────────────────────────────────────

export function PageEditor({
  page,
  allPages,
  onUpdate,
  onDelete,
  onOpenLinkPicker,
  onRemoveLink,
  onNavigateTo,
  onClose = () => {},
  onExportPdf,
  onReviewPage,
  reviewLoading,
  onRegenerateVeille,
  regenerateLoading,
  onDeepAnalyze,
  onResummarise,
  onPlayVideo,
  maxVideoSelect = 10,
  transferImages = false,
  onCvAnalyze,
  onCvRewrite,
  onCvLetter,
  onCvImportPdf,
  onCvTargetJobs,
  onCvAtsKeywords,
  onCvMasterCv,
  onCvAdaptCv,
  onCvFreeQuestion,
  cvBusy = false,
  onTogglePrivate,
  onDuplicatePrompt,
  onTranscribePlaylist,
  onAnalyzeImage,
}: {
  page:             Page;
  allPages:         Page[];
  onUpdate:         (id: string, updates: Partial<Omit<Page, 'id' | 'createdAt'>>) => void;
  onDelete:         () => void;
  onOpenLinkPicker: () => void;
  onRemoveLink:     (targetId: string) => void;
  onNavigateTo:     (id: string) => void;
  onClose?:         () => void;
  onExportPdf?:     () => void;
  onReviewPage?:    () => Promise<void>;
  reviewLoading?:   boolean;
  onRegenerateVeille?: (level: DetailLevel) => Promise<void>;
  regenerateLoading?: boolean;
  onDeepAnalyze?:   (ids: string[]) => Promise<void>;
  onResummarise?:   () => void;
  onPlayVideo?:     (videoId: string, title: string) => void;
  maxVideoSelect?:  number;
  transferImages?:  boolean;
  onCvAnalyze?:     (powerful?: boolean) => Promise<void>;
  onCvRewrite?:     () => void;
  onCvLetter?:      () => void;
  onCvImportPdf?:   () => void;
  onCvTargetJobs?:  () => Promise<void>;
  onCvAtsKeywords?: () => Promise<void>;
  onCvMasterCv?:    () => Promise<void>;
  onCvAdaptCv?:        () => void;
  onCvFreeQuestion?:   () => void;
  cvBusy?:             boolean;
  onTogglePrivate?:    () => void;
  onDuplicatePrompt?:  () => void;
  onTranscribePlaylist?: (ids: string[]) => void;
  onAnalyzeImage?:     (imageId: string) => void;
}) {
  const ALWAYS_READING_KEY = 'docteur.readingModeDefault';
  const [focusedBlockId, setFocusedBlockId]     = useState<string | null>(null);
  const [menuOpen, setMenuOpen]                 = useState(false);
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(() => new Set());
  const [alwaysReading, setAlwaysReading]       = useState(() => localStorage.getItem(ALWAYS_READING_KEY) === 'true');
  const [readingMode, setReadingMode]           = useState(() => localStorage.getItem(ALWAYS_READING_KEY) === 'true');
  const [corpusSummary, setCorpusSummary]           = useState<{ text: string; model: string; truncated: boolean } | null>(null);
  const [corpusSummarizing, setCorpusSummarizing]   = useState(false);
  const [corpusSummaryError, setCorpusSummaryError] = useState<string | null>(null);
  const [regenerateMenuOpen, setRegenerateMenuOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const menuRef  = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Reset reading mode when navigating to a different page
    setReadingMode(localStorage.getItem(ALWAYS_READING_KEY) === 'true');
    setFocusedBlockId(null);
    setCorpusSummary(null);
    setCorpusSummaryError(null);
    if (page.title === 'Nouveau neurone' && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  async function handleSummarizeCorpus() {
    setCorpusSummarizing(true);
    setCorpusSummaryError(null);
    try {
      const result = await cortexClient.corpusSummarize(page.id);
      setCorpusSummary({ text: result.summary, model: result.model_used, truncated: result.truncated });
    } catch (e) {
      setCorpusSummaryError(String((e as Error).message ?? e));
    } finally {
      setCorpusSummarizing(false);
    }
  }

  function handleKeepCorpusSummary() {
    if (!corpusSummary) return;
    const newBlock: Block = {
      id: generateId(), type: 'paragraph',
      content: `Résumé (${corpusSummary.model}) :\n\n${corpusSummary.text}`,
    };
    onUpdate(page.id, { blocks: [...page.blocks, newBlock] });
    setCorpusSummary(null);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (!readingMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setReadingMode(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readingMode]);

  function updateBlock(blockId: string, updates: Partial<Block>) {
    onUpdate(page.id, { blocks: page.blocks.map(b => b.id === blockId ? { ...b, ...updates } : b) });
  }
  function addBlockAfter(afterId: string) {
    const idx        = page.blocks.findIndex(b => b.id === afterId);
    const newBlock: Block = { id: generateId(), type: 'paragraph', content: '' };
    const nextBlocks = [...page.blocks];
    nextBlocks.splice(idx + 1, 0, newBlock);
    onUpdate(page.id, { blocks: nextBlocks });
    setFocusedBlockId(newBlock.id);
  }
  function deleteBlock(blockId: string) {
    if (page.blocks.length <= 1) return;
    const idx        = page.blocks.findIndex(b => b.id === blockId);
    const nextBlocks = page.blocks.filter(b => b.id !== blockId);
    onUpdate(page.id, { blocks: nextBlocks });
    setFocusedBlockId(nextBlocks[Math.max(0, idx - 1)]?.id ?? null);
  }

  async function handleUploadImage(file: File): Promise<string> {
    const { id } = await cortexClient.uploadImage(file);
    return id;
  }

  async function handleDownloadImageUrl(url: string): Promise<string> {
    const { id } = await cortexClient.downloadImageFromUrl(url);
    return id;
  }

  function handleDeleteImage(imageId: string) {
    void cortexClient.deleteImage(imageId);
  }

  // Ctrl+V paste → insert image block after focused block (or at end)
  async function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items);
    const imgItem = items.find(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (!file) return;
    try {
      const imageId = await handleUploadImage(file);
      const newBlock: Block = { id: generateId(), type: 'image', content: imageId };
      const blocks    = [...page.blocks];
      const focusedIdx = focusedBlockId ? blocks.findIndex(b => b.id === focusedBlockId) : -1;
      const insertAt  = focusedIdx >= 0 ? focusedIdx + 1 : blocks.length;
      blocks.splice(insertAt, 0, newBlock);
      onUpdate(page.id, { blocks });
      setFocusedBlockId(newBlock.id);
    } catch {
      // silent — user sees nothing if upload fails; can retry via ImageBlock UI
    }
  }

  const meta        = KIND_META[page.kind];
  const linkedPages = (page.links ?? [])
    .map(id => allPages.find(p => p.id === id))
    .filter(Boolean) as Page[];

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex-shrink-0 pt-8 pb-4" style={{ borderBottom: '1px solid rgba(61,255,170,0.08)', position: 'relative', paddingLeft: 32, paddingRight: 44 }}>
        {onClose && (
          <button
            type="button"
            title="Fermer (Echap)"
            aria-label="Fermer la vue détail"
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded transition-colors"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 5,
              color: '#5a4a7a',
              background: 'rgba(90,74,122,0.12)',
              border: '1px solid rgba(90,74,122,0.2)',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = '#e8d9ff';
              e.currentTarget.style.background = 'rgba(94,231,255,0.12)';
              e.currentTarget.style.borderColor = 'rgba(94,231,255,0.3)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = '#5a4a7a';
              e.currentTarget.style.background = 'rgba(90,74,122,0.12)';
              e.currentTarget.style.borderColor = 'rgba(90,74,122,0.2)';
            }}
          >
            <X size={14} />
          </button>
        )}
        <div className="flex items-center gap-2 mb-3" style={{ flexWrap: 'wrap', rowGap: 6 }}>
          <select
            value={page.kind}
            onChange={e => {
              const nextKind = e.target.value as PageKind;
              // cv/candidature are always treated as private server-side
              // (AUTO_PRIVATE_KINDS) regardless of this flag, but the flag
              // itself should match — otherwise the DB state is misleading
              // even though nothing actually leaks.
              const forcePrivate = nextKind === 'cv' || nextKind === 'candidature';
              onUpdate(page.id, forcePrivate ? { kind: nextKind, private: true } : { kind: nextKind });
            }}
            title="Type de neurone"
            aria-label="Type de neurone"
            className="editor-kind-badge font-mono cursor-pointer border-0 outline-none appearance-none"
            style={{
              fontSize:      10,
              background:    `rgba(${hexRgb(meta.color)}, 0.14)`,
              color:          meta.color,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            {(Object.keys(KIND_META) as PageKind[]).map(k => (
              <option key={k} value={k} style={{ background: '#0f0b1e', color: KIND_META[k].color }}>
                {KIND_META[k].icon}  {KIND_META[k].label}
              </option>
            ))}
          </select>

          {/* Private badge / toggle ── toujours affiché pour cv/candidature, toggleable pour les autres */}
          {(page.kind === 'cv' || page.kind === 'candidature') ? (
            <span
              title="Neurone toujours privé — jamais envoyé au cloud"
              style={{ fontSize: 11, cursor: 'default', opacity: 0.8, userSelect: 'none' }}
            >🔒</span>
          ) : onTogglePrivate ? (
            <button
              type="button"
              title={page.private ? 'Privé — cliquer pour rendre public (cloud possible)' : 'Public — cliquer pour marquer privé (jamais envoyé au cloud)'}
              onClick={onTogglePrivate}
              className="font-mono rounded px-1.5 py-0.5 transition-all"
              style={{
                fontSize: 10, letterSpacing: '0.06em', cursor: 'pointer',
                background: page.private ? 'rgba(244,114,182,0.12)' : 'transparent',
                border: page.private ? '1px solid rgba(244,114,182,0.3)' : '1px solid transparent',
                color: page.private ? '#f472b6' : '#3d3060',
              }}
            >
              {page.private ? '🔒 privé' : '🔓'}
            </button>
          ) : null}

          <span className="flex-1" />

          {/* Resummarise button — analyzed video */}
          {page.kind === 'video' && (page.metadata?.deep_capture === true || page.metadata?.deep_analyzed === true) && onResummarise && (
            <button
              type="button"
              title="Régénérer le résumé avec un niveau de détail choisi"
              onClick={onResummarise}
              className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
              style={{
                fontSize: 10,
                letterSpacing: '0.08em',
                color: '#5ee7ff',
                border: '1px solid rgba(94,231,255,0.2)',
                background: 'transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.4)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.2)'; }}
            >
              <RefreshCw size={11} />
              Régénérer le résumé
            </button>
          )}

          {/* Résumer cet article — corpus de référence, à la demande uniquement */}
          {page.kind === 'corpus' && (
            <button
              type="button"
              title="Générer un résumé de cet article avec l'IA locale (le contenu intégral n'est jamais modifié)"
              onClick={() => { void handleSummarizeCorpus(); }}
              disabled={corpusSummarizing}
              className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
              style={{
                fontSize: 10,
                letterSpacing: '0.08em',
                color: '#84cc16',
                border: '1px solid rgba(132,204,22,0.2)',
                background: 'transparent',
                cursor: corpusSummarizing ? 'default' : 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(132,204,22,0.08)'; e.currentTarget.style.borderColor = 'rgba(132,204,22,0.4)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(132,204,22,0.2)'; }}
            >
              <RefreshCw size={11} className={corpusSummarizing ? 'animate-spin' : undefined} />
              {corpusSummarizing ? 'Résumé en cours…' : 'Résumer cet article'}
            </button>
          )}

          {/* Deep analyze button — any unanalyzed video (not downloaded), regardless of origin */}
          {page.kind === 'video' && page.metadata?.deep_analyzed !== true && !page.metadata?.downloaded && onDeepAnalyze && (
            <button
              type="button"
              title="Analyser en profondeur avec l'IA"
              onClick={() => { void onDeepAnalyze([page.id]); }}
              className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
              style={{
                fontSize: 10,
                letterSpacing: '0.08em',
                color: '#a78bfa',
                border: '1px solid rgba(167,139,250,0.2)',
                background: 'transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(167,139,250,0.1)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.4)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.2)'; }}
            >
              <Zap size={11} />
              Analyser en profondeur
            </button>
          )}

          {/* Transcribe playlist / channel — show when there are untranscribed linked video pages */}
          {(page.kind === 'playlist' || page.kind === 'channel') && onTranscribePlaylist && (() => {
            const unTranscribed = (page.links ?? []).filter(id => {
              const p = allPages.find(x => x.id === id);
              return p?.kind === 'video' && !p.metadata?.transcription_provider && !p.metadata?.deep_capture;
            });
            if (unTranscribed.length === 0) return null;
            const btnLabel = page.kind === 'channel'
              ? `🎙️ Transcrire toutes les vidéos (${unTranscribed.length})`
              : `🎙️ Transcrire les vidéos (${unTranscribed.length})`;
            return (
              <button
                type="button"
                title={`${unTranscribed.length} vidéo${unTranscribed.length !== 1 ? 's' : ''} non transcrites`}
                onClick={() => onTranscribePlaylist(unTranscribed)}
                className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                style={{ fontSize: 10, letterSpacing: '0.08em', color: '#f97316', border: '1px solid rgba(249,115,22,0.2)', background: 'transparent', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(249,115,22,0.1)'; e.currentTarget.style.borderColor = 'rgba(249,115,22,0.4)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(249,115,22,0.2)'; }}
              >
                {btnLabel}
              </button>
            );
          })()}

          {/* Detail level badge — only on recherche neurons that have one */}
          {page.kind === 'recherche' && page.metadata?.detailLevel != null && (
            <span
              title="Niveau de détail utilisé pour cette veille"
              className="font-mono"
              style={{
                fontSize: 9, letterSpacing: '0.08em', padding: '2px 6px', borderRadius: 5,
                color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)', background: 'rgba(167,139,250,0.08)',
              }}
            >
              {DETAIL_LEVEL_LABELS[page.metadata.detailLevel as DetailLevel] ?? String(page.metadata.detailLevel)}
            </span>
          )}

          {/* Régénérer à un autre niveau — only on recherche neurons with a known subject */}
          {page.kind === 'recherche' && typeof page.metadata?.subject === 'string' && onRegenerateVeille && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                title={regenerateLoading ? 'Régénération en cours…' : 'Régénérer cette veille à un autre niveau de détail'}
                disabled={regenerateLoading}
                onClick={() => setRegenerateMenuOpen(o => !o)}
                className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                style={{
                  fontSize: 10, letterSpacing: '0.08em',
                  color: '#a78bfa',
                  border: '1px solid rgba(167,139,250,0.2)',
                  background: regenerateMenuOpen ? 'rgba(167,139,250,0.1)' : 'transparent',
                  cursor: regenerateLoading ? 'default' : 'pointer',
                  opacity: regenerateLoading ? 0.7 : 1,
                }}
                onMouseEnter={e => { if (!regenerateLoading) { e.currentTarget.style.background = 'rgba(167,139,250,0.1)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.4)'; } }}
                onMouseLeave={e => { if (!regenerateLoading && !regenerateMenuOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.2)'; } }}
              >
                {regenerateLoading
                  ? <RefreshCw size={11} className="animate-spin" />
                  : <RefreshCw size={11} />}
                {regenerateLoading ? 'Régénération…' : 'Régénérer à un autre niveau'}
              </button>
              {regenerateMenuOpen && !regenerateLoading && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20,
                  background: '#150f28', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 8,
                  padding: 6, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 140,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                }}>
                  {(['synthese', 'standard', 'pedagogique', 'expert'] as DetailLevel[]).map(level => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => { setRegenerateMenuOpen(false); void onRegenerateVeille(level); }}
                      className="font-mono"
                      style={{
                        textAlign: 'left', padding: '6px 8px', borderRadius: 5, fontSize: 10.5,
                        color: '#c8b8e8', background: 'transparent', border: 'none', cursor: 'pointer',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(167,139,250,0.12)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {DETAIL_LEVEL_LABELS[level]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Review button — only on recherche neurons */}
          {page.kind === 'recherche' && onReviewPage && (
            <button
              type="button"
              title={reviewLoading ? 'Relecture en cours…' : 'Faire relire par l\'IA (gemini-3.1-flash-lite)'}
              disabled={reviewLoading}
              onClick={() => { void onReviewPage(); }}
              className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
              style={{
                fontSize:   10,
                letterSpacing: '0.08em',
                color:      reviewLoading ? '#f59e0b' : '#f59e0b',
                border:     `1px solid ${reviewLoading ? 'rgba(245,158,11,0.3)' : 'rgba(245,158,11,0.15)'}`,
                background:  reviewLoading ? 'rgba(245,158,11,0.08)' : 'transparent',
                cursor:      reviewLoading ? 'default' : 'pointer',
                opacity:     reviewLoading ? 0.7 : 1,
              }}
              onMouseEnter={e => { if (!reviewLoading) { e.currentTarget.style.background = 'rgba(245,158,11,0.1)'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.35)'; } }}
              onMouseLeave={e => { if (!reviewLoading) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.15)'; } }}
            >
              {reviewLoading
                ? <RefreshCw size={11} className="animate-spin" />
                : <Eye size={11} />}
              {reviewLoading ? 'Relecture…' : 'Faire relire'}
            </button>
          )}

          {/* CV action buttons — only on cv neurons */}
          {page.kind === 'cv' && (onCvAnalyze || onCvRewrite || onCvLetter || onCvImportPdf || onCvTargetJobs || onCvAtsKeywords || onCvMasterCv || onCvAdaptCv || onCvFreeQuestion) && (
            <>
              <span style={{ fontSize: 8, color: '#f472b6', fontFamily: 'monospace', opacity: 0.7, paddingRight: 2 }}>🔒 local</span>
              {onCvAnalyze && (
                <button
                  type="button"
                  title={cvBusy ? 'Analyse en cours…' : 'Analyser ce CV (100% local)'}
                  disabled={cvBusy}
                  onClick={() => { void onCvAnalyze(false); }}
                  onContextMenu={e => { e.preventDefault(); void onCvAnalyze(true); }}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: cvBusy ? '#f472b699' : '#f472b6', border: `1px solid ${cvBusy ? 'rgba(244,114,182,0.15)' : 'rgba(244,114,182,0.2)'}`, background: 'transparent', cursor: cvBusy ? 'default' : 'pointer' }}
                  onMouseEnter={e => { if (!cvBusy) { e.currentTarget.style.background = 'rgba(244,114,182,0.1)'; e.currentTarget.style.borderColor = 'rgba(244,114,182,0.4)'; } }}
                  onMouseLeave={e => { if (!cvBusy) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(244,114,182,0.2)'; } }}
                >
                  {cvBusy ? <RefreshCw size={11} className="animate-spin" /> : <Eye size={11} />}
                  {cvBusy ? 'Analyse…' : 'Analyser'}
                </button>
              )}
              {onCvRewrite && (
                <button
                  type="button"
                  title={cvBusy ? 'En cours…' : 'Réécrire ce CV (clic droit = modèle puissant)'}
                  disabled={cvBusy}
                  onClick={() => { onCvRewrite(); }}
                  onContextMenu={e => { e.preventDefault(); onCvRewrite(); }}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: cvBusy ? '#f472b699' : '#f472b6', border: `1px solid ${cvBusy ? 'rgba(244,114,182,0.15)' : 'rgba(244,114,182,0.2)'}`, background: 'transparent', cursor: cvBusy ? 'default' : 'pointer' }}
                  onMouseEnter={e => { if (!cvBusy) { e.currentTarget.style.background = 'rgba(244,114,182,0.1)'; e.currentTarget.style.borderColor = 'rgba(244,114,182,0.4)'; } }}
                  onMouseLeave={e => { if (!cvBusy) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(244,114,182,0.2)'; } }}
                >
                  <Zap size={11} />
                  Réécrire
                </button>
              )}
              {onCvLetter && (
                <button
                  type="button"
                  title="Générer une lettre / mail de motivation"
                  onClick={onCvLetter}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(251,191,36,0.1)'; e.currentTarget.style.borderColor = 'rgba(251,191,36,0.4)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(251,191,36,0.2)'; }}
                >
                  ✉ Lettre
                </button>
              )}
              {onCvImportPdf && (
                <button
                  type="button"
                  title="Importer un CV depuis un fichier PDF (100% local)"
                  onClick={onCvImportPdf}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.2)', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(148,163,184,0.1)'; e.currentTarget.style.borderColor = 'rgba(148,163,184,0.4)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(148,163,184,0.2)'; }}
                >
                  ↑ PDF
                </button>
              )}
              {onCvTargetJobs && (
                <button
                  type="button"
                  title={cvBusy ? 'En cours…' : 'Postes pour lesquels je suis qualifié (100% local)'}
                  disabled={cvBusy}
                  onClick={() => { void onCvTargetJobs(); }}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: cvBusy ? '#a78bfa99' : '#a78bfa', border: `1px solid ${cvBusy ? 'rgba(167,139,250,0.15)' : 'rgba(167,139,250,0.2)'}`, background: 'transparent', cursor: cvBusy ? 'default' : 'pointer' }}
                  onMouseEnter={e => { if (!cvBusy) { e.currentTarget.style.background = 'rgba(167,139,250,0.1)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.4)'; } }}
                  onMouseLeave={e => { if (!cvBusy) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.2)'; } }}
                >
                  {cvBusy ? <RefreshCw size={11} className="animate-spin" /> : '🎯'}
                  Postes cibles
                </button>
              )}
              {onCvAtsKeywords && (
                <button
                  type="button"
                  title={cvBusy ? 'En cours…' : 'Mots-clés ATS à inclure (100% local)'}
                  disabled={cvBusy}
                  onClick={() => { void onCvAtsKeywords(); }}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: cvBusy ? '#3dffaa99' : '#3dffaa', border: `1px solid ${cvBusy ? 'rgba(61,255,170,0.15)' : 'rgba(61,255,170,0.2)'}`, background: 'transparent', cursor: cvBusy ? 'default' : 'pointer' }}
                  onMouseEnter={e => { if (!cvBusy) { e.currentTarget.style.background = 'rgba(61,255,170,0.07)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.4)'; } }}
                  onMouseLeave={e => { if (!cvBusy) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.2)'; } }}
                >
                  {cvBusy ? <RefreshCw size={11} className="animate-spin" /> : '#'}
                  Mots-clés ATS
                </button>
              )}
              {onCvMasterCv && (
                <button
                  type="button"
                  title={cvBusy ? 'En cours…' : 'Générer le CV master (version complète, 100% local)'}
                  disabled={cvBusy}
                  onClick={() => { void onCvMasterCv(); }}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: cvBusy ? '#5ee7ff99' : '#5ee7ff', border: `1px solid ${cvBusy ? 'rgba(94,231,255,0.15)' : 'rgba(94,231,255,0.2)'}`, background: 'transparent', cursor: cvBusy ? 'default' : 'pointer' }}
                  onMouseEnter={e => { if (!cvBusy) { e.currentTarget.style.background = 'rgba(94,231,255,0.07)'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.4)'; } }}
                  onMouseLeave={e => { if (!cvBusy) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.2)'; } }}
                >
                  {cvBusy ? <RefreshCw size={11} className="animate-spin" /> : '★'}
                  CV master
                </button>
              )}
              {onCvAdaptCv && (
                <button
                  type="button"
                  title="Adapter ce CV à une offre d'emploi (100% local)"
                  onClick={onCvAdaptCv}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: '#f97316', border: '1px solid rgba(249,115,22,0.2)', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(249,115,22,0.08)'; e.currentTarget.style.borderColor = 'rgba(249,115,22,0.4)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(249,115,22,0.2)'; }}
                >
                  ⚡ Adapter offre
                </button>
              )}
              {onCvFreeQuestion && (
                <button
                  type="button"
                  title="Poser une question libre sur ce CV (100% local)"
                  onClick={onCvFreeQuestion}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: '#c084fc', border: '1px solid rgba(192,132,252,0.2)', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(192,132,252,0.08)'; e.currentTarget.style.borderColor = 'rgba(192,132,252,0.4)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(192,132,252,0.2)'; }}
                >
                  ? Question libre
                </button>
              )}
            </>
          )}

          {/* Prompt buttons — copy content + duplicate and adapt */}
          {page.kind === 'prompt' && (
            <>
              <button
                type="button"
                title="Copier le contenu du prompt dans le presse-papier"
                onClick={() => {
                  const text = page.blocks.map(b => b.content).filter(Boolean).join('\n\n');
                  void navigator.clipboard.writeText(text);
                }}
                className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                style={{ fontSize: 10, letterSpacing: '0.08em', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)', background: 'transparent', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(52,211,153,0.08)'; e.currentTarget.style.borderColor = 'rgba(52,211,153,0.4)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(52,211,153,0.2)'; }}
              >
                ⎘ Copier
              </button>
              {onDuplicatePrompt && (
                <button
                  type="button"
                  title="Dupliquer ce prompt pour l'adapter à un autre contexte"
                  onClick={onDuplicatePrompt}
                  className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
                  style={{ fontSize: 10, letterSpacing: '0.08em', color: '#34d399', border: '1px solid rgba(52,211,153,0.15)', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(52,211,153,0.06)'; e.currentTarget.style.borderColor = 'rgba(52,211,153,0.35)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(52,211,153,0.15)'; }}
                >
                  ⎘ Dupliquer et adapter
                </button>
              )}
            </>
          )}

          {/* Reading mode button — hidden while editing a block */}
          {!focusedBlockId && (
            <button
              type="button"
              title={readingMode ? 'Quitter le mode lecture (Échap)' : 'Mode lecture'}
              onClick={() => { setReadingMode(v => !v); if (readingMode) return; setFocusedBlockId(null); }}
              className="flex items-center gap-1.5 font-mono rounded px-2 py-1 transition-all"
              style={{
                fontSize:    10,
                letterSpacing: '0.08em',
                color:       readingMode ? '#3dffaa' : '#5a4a7a',
                border:      `1px solid ${readingMode ? 'rgba(61,255,170,0.3)' : 'rgba(90,74,122,0.2)'}`,
                background:  readingMode ? 'rgba(61,255,170,0.08)' : 'transparent',
              }}
              onMouseEnter={e => { if (!readingMode) { e.currentTarget.style.color = '#3dffaa'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.25)'; } }}
              onMouseLeave={e => { if (!readingMode) { e.currentTarget.style.color = '#5a4a7a'; e.currentTarget.style.borderColor = 'rgba(90,74,122,0.2)'; } }}
            >
              <BookOpen size={11} />
              {readingMode ? 'Lecture ✓' : 'Lecture'}
            </button>
          )}

          {/* Kebab menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(v => !v)}
              className="flex items-center justify-center w-7 h-7 rounded transition-colors"
              style={{ color: menuOpen ? '#e8d9ff' : '#5a4a7a' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#e8d9ff')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.color = '#5a4a7a'; }}
              title="Options"
            >
              <MoreVertical size={14} />
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 py-1 rounded z-50"
                style={{
                  background:     'rgba(12, 10, 22, 0.97)',
                  border:         '1px solid rgba(61,255,170,0.12)',
                  minWidth:       160,
                  backdropFilter: 'blur(16px)',
                }}
              >
                {onExportPdf && (
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-left font-mono text-xs"
                    style={{ color: '#5ee7ff' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(94,231,255,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => { setMenuOpen(false); onExportPdf(); }}
                  >
                    <FileText size={12} />
                    Exporter en PDF
                  </button>
                )}
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-left font-mono text-xs"
                  style={{ color: '#ff4d58' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,77,88,0.08)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                >
                  <Trash2 size={12} />
                  Supprimer le neurone
                </button>
              </div>
            )}
          </div>
        </div>

        <textarea
          ref={titleRef}
          rows={3}
          value={page.title}
          placeholder="Titre du neurone"
          className="w-full bg-transparent border-0 outline-0 font-grotesk font-bold"
          style={{ fontSize: '1.75rem', color: '#f0eaff', lineHeight: 1.2, caretColor: '#3dffaa', letterSpacing: '-0.01em' }}
          onChange={e => onUpdate(page.id, { title: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); setFocusedBlockId(page.blocks[0]?.id ?? null); }
          }}
        />
        <p className="font-mono mt-2" style={{ color: '#2e2555', fontSize: 10 }}>
          Créé {formatDate(page.createdAt)} · Modifié {formatDate(page.updatedAt)}
          {(() => {
            const tp = page.metadata?.transcription_provider as string | undefined;
            if (!tp) return null;
            const label = tp === 'whisper_local' ? '🔒 Whisper local' : tp === 'whisper_groq' ? '⚡ Whisper Groq' : tp;
            const isGroq = tp === 'whisper_groq';
            return (
              <span style={{
                marginLeft: 10,
                padding: '1px 7px',
                borderRadius: 999,
                background: isGroq ? 'rgba(249,115,22,0.12)' : 'rgba(52,211,153,0.10)',
                border: `1px solid ${isGroq ? 'rgba(249,115,22,0.3)' : 'rgba(52,211,153,0.25)'}`,
                color: isGroq ? '#f97316' : '#34d399',
                fontSize: 10,
              }}>
                {label}
              </span>
            );
          })()}
        </p>
      </div>

      {/* Prompt metadata panel */}
      {page.kind === 'prompt' && (
        <PromptMeta page={page} onUpdate={onUpdate} />
      )}

      {/* Résumé corpus — à la demande, ne remplace jamais le contenu intégral */}
      {page.kind === 'corpus' && (corpusSummary || corpusSummaryError) && (
        <div className="mx-8 mb-4 px-4 py-3 rounded font-mono text-xs" style={{
          background: corpusSummaryError ? 'rgba(255,77,88,0.06)' : 'rgba(132,204,22,0.06)',
          border: `1px solid ${corpusSummaryError ? 'rgba(255,77,88,0.2)' : 'rgba(132,204,22,0.2)'}`,
        }}>
          {corpusSummaryError ? (
            <p style={{ color: '#ff4d58' }}>{corpusSummaryError}</p>
          ) : corpusSummary && (
            <>
              <p style={{ color: '#c0e0a0', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{corpusSummary.text}</p>
              <div className="flex items-center gap-3 mt-2" style={{ color: '#7a9a5a', fontSize: 10 }}>
                <span>{corpusSummary.model} · résumé généré localement{corpusSummary.truncated ? ' · article tronqué pour le résumé (contenu intégral conservé)' : ''}</span>
                <button type="button" onClick={handleKeepCorpusSummary} style={{ color: '#84cc16', cursor: 'pointer' }}>
                  Ajouter au neurone
                </button>
                <button type="button" onClick={() => setCorpusSummary(null)} style={{ color: '#5a4a7a', cursor: 'pointer' }}>
                  Ignorer
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Blocks — mode normal ou mode lecture */}
      {readingMode ? (
        <ReadingView
          blocks={page.blocks}
          onPlayVideo={onPlayVideo ? (videoId) => onPlayVideo(videoId, page.title) : undefined}
          alwaysOn={alwaysReading}
          onToggleAlwaysOn={() => {
            const next = !alwaysReading;
            setAlwaysReading(next);
            localStorage.setItem(ALWAYS_READING_KEY, String(next));
          }}
          onClose={onClose}
        />
      ) : (
        <div className="flex-1 px-8 py-5" onPaste={e => void handlePaste(e)}>
          {page.blocks.map(block => (
            <BlockComp
              key={block.id}
              block={block}
              focused={focusedBlockId === block.id}
              onFocus={() => setFocusedBlockId(block.id)}
              onChange={updates => updateBlock(block.id, updates)}
              onEnter={() => addBlockAfter(block.id)}
              onDelete={() => deleteBlock(block.id)}
              onUploadImage={handleUploadImage}
              onDownloadImageUrl={handleDownloadImageUrl}
              onDeleteImage={handleDeleteImage}
              onAnalyzeImage={onAnalyzeImage}
              transferImages={transferImages}
              onPlayVideo={onPlayVideo ? (videoId) => {
                if (!videoId) return;
                onPlayVideo(videoId, page.title);
              } : undefined}
            />
          ))}
          <div
            className="h-16 cursor-text"
            onClick={() => { const last = page.blocks[page.blocks.length - 1]; if (last) setFocusedBlockId(last.id); }}
          />
        </div>
      )}

      {/* Synapses */}
      <div className="flex-shrink-0 px-8 py-4" style={{ borderTop: '1px solid rgba(61,255,170,0.08)' }}>
        {/* Multi-select "Analyser" bar — shown whenever light videos are selected, regardless of parent kind */}
        {onDeepAnalyze && selectedVideoIds.size > 0 && (
          <div className="flex items-center gap-2 mb-3 px-2 py-2 rounded" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
            <Zap size={11} style={{ color: '#a78bfa', flexShrink: 0 }} />
            <span className="font-mono flex-1" style={{ color: '#a78bfa', fontSize: 10 }}>
              {selectedVideoIds.size} vidéo{selectedVideoIds.size > 1 ? 's' : ''} sélectionnée{selectedVideoIds.size > 1 ? 's' : ''}
            </span>
            <button
              type="button"
              onClick={() => { void onDeepAnalyze(Array.from(selectedVideoIds)); setSelectedVideoIds(new Set()); }}
              className="font-mono rounded px-2 py-0.5"
              style={{ fontSize: 10, color: '#a78bfa', border: '1px solid rgba(167,139,250,0.35)', background: 'transparent' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(167,139,250,0.15)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              Analyser la sélection
            </button>
            <button
              type="button"
              onClick={() => setSelectedVideoIds(new Set())}
              style={{ color: '#5a4a7a' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#9080c0')}
              onMouseLeave={e => (e.currentTarget.style.color = '#5a4a7a')}
            >
              <X size={11} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 10, letterSpacing: '0.14em' }}>
            SYNAPSES{linkedPages.length > 0 ? ` (${linkedPages.length})` : ''}
          </span>
          <button
            type="button"
            onClick={onOpenLinkPicker}
            className="flex items-center gap-1 font-mono text-xs"
            style={{ color: '#3dffaa' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#7fffd4')}
            onMouseLeave={e => (e.currentTarget.style.color = '#3dffaa')}
          >
            <Plus size={10} />
            Lier
          </button>
        </div>

        {linkedPages.length === 0 ? (
          <p className="font-mono" style={{ color: '#2e2555', fontSize: 11 }}>
            Aucune synapse — cliquez sur Lier pour connecter des neurones
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {linkedPages.map(linked => {
              const lmeta = KIND_META[linked.kind];
              const isLightVideo = linked.kind === 'video' && linked.metadata?.deep_analyzed !== true && !linked.metadata?.downloaded;
              const canMultiSelect = isLightVideo && !!onDeepAnalyze;
              const isChecked = selectedVideoIds.has(linked.id);
              return (
                <div
                  key={linked.id}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer"
                  style={{ background: isChecked ? 'rgba(167,139,250,0.08)' : 'rgba(94,231,255,0.04)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = isChecked ? 'rgba(167,139,250,0.12)' : 'rgba(94,231,255,0.08)')}
                  onMouseLeave={e => (e.currentTarget.style.background = isChecked ? 'rgba(167,139,250,0.08)' : 'rgba(94,231,255,0.04)')}
                  onClick={() => {
                    if (canMultiSelect) {
                      setSelectedVideoIds(prev => {
                        const next = new Set(prev);
                        if (next.has(linked.id)) {
                          next.delete(linked.id);
                        } else if (next.size >= maxVideoSelect) {
                          // guard: max — don't add, caller sees toast via onDeepAnalyze guard
                          return prev;
                        } else {
                          next.add(linked.id);
                        }
                        return next;
                      });
                    } else {
                      onNavigateTo(linked.id);
                    }
                  }}
                >
                  {canMultiSelect ? (
                    <input
                      type="checkbox"
                      readOnly
                      checked={isChecked}
                      style={{ accentColor: '#a78bfa', width: 12, height: 12, flexShrink: 0, cursor: 'pointer' }}
                      onClick={e => e.stopPropagation()}
                      onChange={() => {
                        setSelectedVideoIds(prev => {
                          const next = new Set(prev);
                          if (next.has(linked.id)) { next.delete(linked.id); }
                          else if (next.size < 10) { next.add(linked.id); }
                          return next;
                        });
                      }}
                    />
                  ) : (
                    <span style={{ color: lmeta.color, fontSize: 12 }}>{lmeta.icon}</span>
                  )}
                  <span className="flex-1 font-mono text-xs truncate" style={{ color: canMultiSelect ? (isChecked ? '#c4b5fd' : '#9080c0') : '#9080c0' }}>
                    {linked.title || 'Sans titre'}
                  </span>
                  {canMultiSelect && !isChecked ? (
                    <button
                      type="button"
                      title="Ouvrir"
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: '#5a4a7a', fontSize: 10 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#a78bfa')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#5a4a7a')}
                      onClick={e => { e.stopPropagation(); onNavigateTo(linked.id); }}
                    >
                      <Eye size={10} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Supprimer la synapse vers ${linked.title || 'Sans titre'}`}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: '#5a4a7a' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#ff4d58')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#5a4a7a')}
                      onClick={e => { e.stopPropagation(); onRemoveLink(linked.id); }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { pages, loading, writeError, isOnline, pageCounts, allMetaLoaded, pageContentLoading, createPage, createPageFromData, updatePage, upsertPage, removePage, createLink, removeLink, flushAllSaves, reloadFromServer, loadPage, loadAllMeta, loadAllPagesForReindex } = usePages();
  const offline = isOnline === false;
  const cortex  = useCortex();
  // scheduleIndex is a stable useCallback in useCortex — destructure to avoid the `cortex`
  // object reference (which changes every render) propagating into deps of heavy callbacks.
  const { scheduleIndex: cortexScheduleIndex } = cortex;
  // Stable ref to latest pages — avoids adding `pages` to handleUpdatePage's dep array,
  // which would recreate the callback on every keystroke and cascade unnecessary re-renders.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const isMobile = useMobile();
  const [showMobileBrain, setShowMobileBrain] = useState(false);

  const [selectedId, setSelectedId]           = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId]  = useState<string | null>(null);
  useModalOpenTracking(!!pendingDeleteId);
  const [linkPickerForId, setLinkPickerForId]  = useState<string | null>(null);
  useModalOpenTracking(!!linkPickerForId);
  const [toast, setToast]                      = useState<string | null>(null);

  // Surface server write errors (remote mode) as toast
  useEffect(() => { if (writeError) setToast(writeError); }, [writeError]);

  // Surface silent CORS/connection-refused failures (e.g. dev server bumped
  // to a port cortex-server's CORS allowlist doesn't recognize) as a toast.
  useEffect(() => { onConnectionError(msg => setToast(msg)); }, []);

  // When closing a neuron (selectedId => null), flush pending debounced saves
  useEffect(() => {
    if (selectedId === null) {
      void flushAllSaves();
    }
  }, [selectedId, flushAllSaves]);

  // Ensure we attempt to flush pending saves on page unload/navigation
  useEffect(() => {
    function onBeforeUnload() {
      try { void flushAllSaves(); } catch { /* best-effort */ }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [flushAllSaves]);

  useEffect(() => {
    cortexClient.getShortcuts().then(s => setCustomShortcuts(s)).catch(() => {});
  }, []);
  const [showReindex, setShowReindex]          = useState(false);
  useModalOpenTracking(showReindex);
  const [reindexRunning, setReindexRunning]    = useState(false);
  const [reviewingId, setReviewingId]          = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId]    = useState<string | null>(null);
  const [resummariseId, setResummariseId]      = useState<string | null>(null);
  useModalOpenTracking(!!resummariseId);
  const [compareQuestion, setCompareQuestion]  = useState<string | null>(null);
  useModalOpenTracking(!!compareQuestion);
  const [reindexProgress, setReindexProgress]  = useState(0);
  const [consoleOpen, setConsoleOpen]          = useState(false);
  useModalOpenTracking(consoleOpen);
  const [activeVideo, setActiveVideo]          = useState<{ videoId: string; title: string } | null>(null);
  useModalOpenTracking(!!activeVideo);
  const [sourceHighlights, setSourceHighlights] = useState<Set<string>>(new Set());
  const [backupOpen, setBackupOpen]            = useState(false);
  useModalOpenTracking(backupOpen);
  const [corpusOpen, setCorpusOpen]            = useState(false);
  useModalOpenTracking(corpusOpen);
  const [activityLogOpen, setActivityLogOpen]  = useState(false);
  useModalOpenTracking(activityLogOpen);
  const [corpusShow3D, setCorpusShow3D]        = useState(getCorpusShowIn3D());
  const [settingsOpen, setSettingsOpen]        = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  useModalOpenTracking(settingsOpen);
  const [captureOpen, setCaptureOpen]          = useState(false);
  useModalOpenTracking(captureOpen);
  const [helpOpen, setHelpOpen]                = useState(false);
  useModalOpenTracking(helpOpen);
  const [roadmapOpen, setRoadmapOpen]          = useState(false);
  useModalOpenTracking(roadmapOpen);
  const [agentsOpen, setAgentsOpen]            = useState(false);
  useModalOpenTracking(agentsOpen);
  const [videoSummaryOpen, setVideoSummaryOpen] = useState(false);
  const [videoSummaryMinimized, setVideoSummaryMinimized] = useState(false);
  useModalOpenTracking(videoSummaryOpen && !videoSummaryMinimized);
  const [strictLocalMode, setStrictLocalMode]  = useState(false);
  const [skillsOpen, setSkillsOpen]            = useState(false);
  useModalOpenTracking(skillsOpen);
  const [promptGeneratorOpen, setPromptGeneratorOpen] = useState(false);
  useModalOpenTracking(promptGeneratorOpen);
  const [kiwixOpen, setKiwixOpen]              = useState(false);
  useModalOpenTracking(kiwixOpen);
  const [teacherOpen, setTeacherOpen]          = useState(false);
  useModalOpenTracking(teacherOpen);
  const [notebookOpen, setNotebookOpen]        = useState(false);
  useModalOpenTracking(notebookOpen);
  const [imageGeneratorOpen, setImageGeneratorOpen] = useState(false);
  const [metaGptStudioOpen, setMetaGptStudioOpen] = useState(false);
  useModalOpenTracking(metaGptStudioOpen);
  useModalOpenTracking(imageGeneratorOpen);
  const audioPlayerToggleRef = useRef<(() => void) | null>(null);
  const [todoOpen, setTodoOpen]                = useState(false);
  useModalOpenTracking(todoOpen);
  const [todoPendingCount, setTodoPendingCount] = useState(0);
  const [pdfExportPage, setPdfExportPage]      = useState<{ pageId: string; title: string } | null>(null);
  const [pdfSubjectInitial, setPdfSubjectInitial] = useState('');
  const [deepResearchProgress, setDeepResearchProgress] = useState<{ current: number; total: number; topic: string } | null>(null);
  const deepResearchCancelRef = useRef(false);
  const [voiceSettings,      setVoiceSettings]     = useState<VoiceSettings | null>(null);
  const [voiceConsoleQuery,  setVoiceConsoleQuery]  = useState<string | null>(null);

  // ── Gesture camera ──────────────────────────────────────────────────────────
  const gestureInputRef = useRef<((rotDx: number, rotDy: number, zoomDelta: number) => void) | null>(null);
  const [gestureSensitivity, setGestureSensitivityState] = useState<number>(() => getGestureSensitivity());
  const [easterEggEnabled, setEasterEggEnabledState] = useState<boolean>(() => getEasterEggEnabled());
  const [systemOffline, setSystemOffline] = useState(false);

  // ── Vision (analyse d'image locale) ─────────────────────────────────────────
  const [visionImageId, setVisionImageId] = useState<string | null>(null);

  // ── Conversation mode (chat, 100% local) ────────────────────────────────────
  const [conversationOpen, setConversationOpen] = useState(false);
  useModalOpenTracking(conversationOpen);
  // gesture.stop isn't defined yet at this point (useGestureCamera is called
  // below, and needs handleEasterEgg as one of its params) — same
  // ref-indirection pattern as gestureInputRef just above, for the same reason.
  const gestureStopRef = useRef<() => void>(() => {});

  const gestureSettings = {
    cortex3dEnabled:   true,
    navigationEnabled: true,
    sensitivity:       gestureSensitivity,
    easterEggEnabled,
  };

  // Majeur tendu → easter egg : sauvegarde forcée, voix robotique, écran de
  // coupure. Volontairement irréversible sans rechargement (F5) — aucune
  // donnée n'est perdue car flushAllSaves() est attendu avant l'extinction.
  const handleEasterEgg = useCallback(() => {
    void (async () => {
      try { await flushAllSaves(); } catch { /* best-effort, l'écran s'affiche quand même */ }
      speakEasterEgg();
      gestureStopRef.current();
      setSystemOffline(true);
    })();
  }, [flushAllSaves]);

  const gesture = useGestureCamera({
    settings:  gestureSettings,
    onRotate:  useCallback((dx: number, dy: number) => {
      // gestureInputRef.current is set by NeuralBrain's mount effect — if it's
      // null here, the gesture is recognized (logged upstream) but has nowhere
      // to go. Surface that loudly instead of swallowing it via `?.()`.
      if (!gestureInputRef.current) {
        console.warn('[gesture] onRotate fired but gestureInputRef.current is null — NeuralBrain not mounted/wired yet, rotation dropped');
        return;
      }
      gestureInputRef.current(dx, dy, 0);
    }, []),
    onZoom:    useCallback((delta: number) => {
      if (!gestureInputRef.current) {
        console.warn('[gesture] onZoom fired but gestureInputRef.current is null — NeuralBrain not mounted/wired yet, zoom dropped');
        return;
      }
      gestureInputRef.current(0, 0, delta);
    }, []),
    onNext: useCallback(() => { window.dispatchEvent(new CustomEvent('docteur-sidebar-gesture', { detail: { action: 'next', gestureInputPresent: !!gestureInputRef.current } })); }, []),
    onPrev: useCallback(() => { window.dispatchEvent(new CustomEvent('docteur-sidebar-gesture', { detail: { action: 'prev', gestureInputPresent: !!gestureInputRef.current } })); }, []),
    onScroll: useCallback((direction: 1 | -1) => { window.dispatchEvent(new CustomEvent('docteur-sidebar-gesture', { detail: { action: 'scroll', direction, gestureInputPresent: !!gestureInputRef.current } })); }, []),
    onEasterEgg: handleEasterEgg,
  });
  gestureStopRef.current = gesture.stop;

  // ── Screen share + camera photo, sharing the same capture→crop→OCR flow ──────
  // (ScreenCaptureModal / useScreenOcr are source-agnostic — reused as-is for
  // both entry points, only the metadata "source" tag differs.)
  const screenShare = useScreenShare();
  const [screenCaptureImage, setScreenCaptureImage]   = useState<string | null>(null);
  useModalOpenTracking(!!screenCaptureImage);
  const [screenCaptureSource, setScreenCaptureSource] = useState<'screen_share' | 'camera_photo'>('screen_share');

  function handleScreenCapture() {
    const frame = screenShare.captureFrame();
    if (!frame) { setToast('Capture impossible — le partage n\'est pas encore prêt'); return; }
    setScreenCaptureSource('screen_share');
    setScreenCaptureImage(frame);
  }

  function handleCameraPhotoCapture() {
    const frame = gesture.capturePhoto();
    if (!frame) { setToast('Capture impossible — la caméra n\'est pas encore prête'); return; }
    setScreenCaptureSource('camera_photo');
    setScreenCaptureImage(frame);
  }

  const CAPTURE_LABELS: Record<'screen_share' | 'camera_photo', string> = {
    screen_share: 'Capture d\'écran',
    camera_photo: 'Photo',
  };

  async function handleScreenSaveImage(dataUrl: string) {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' });
    const { id: imageId } = await cortexClient.uploadImage(file);
    const date = new Date().toLocaleDateString('fr-FR');
    const page = await createPageFromData({
      title: `${CAPTURE_LABELS[screenCaptureSource]} — ${date}`,
      kind: 'note',
      blocks: [{ id: generateId(), type: 'image', content: imageId }],
      metadata: { source: screenCaptureSource, method: 'screenshot', capturedAt: Date.now() },
    });
    cortex.scheduleIndex(page);
    setSelectedId(page.id);
    setToast('Neurone créé avec l\'image');
  }

  async function handleScreenAnalyzeImage(dataUrl: string) {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' });
    const { id: imageId } = await cortexClient.uploadImage(file);
    setVisionImageId(imageId);
  }

  async function handleScreenSaveText(text: string, dataUrl: string | null) {
    const date = new Date().toLocaleDateString('fr-FR');
    const firstLine = text.split('\n').find(l => l.trim());
    const title = firstLine ? firstLine.trim().slice(0, 60) : `${CAPTURE_LABELS[screenCaptureSource]} — ${date}`;
    const blocks: Block[] = [];
    if (dataUrl) {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' });
      const { id: imageId } = await cortexClient.uploadImage(file);
      blocks.push({ id: generateId(), type: 'image', content: imageId });
    }
    blocks.push(...createContentBlocks(text, title));
    const page = await createPageFromData({
      title,
      kind: 'note',
      blocks,
      metadata: { source: screenCaptureSource, method: 'ocr', capturedAt: Date.now() },
    });
    cortex.scheduleIndex(page);
    setSelectedId(page.id);
    setToast('Neurone créé avec le texte extrait');
  }

  // ── Voice activation ────────────────────────────────────────────────────────
  const voice = useVoiceActivation({
    settings: voiceSettings,
    onCommand: (text) => {
      const lower = text.toLowerCase().trim();
      if (/active.*cam[eé]ra|cam[eé]ra.*active/.test(lower)) {
        if (gesture.gestureState === 'idle' || gesture.gestureState === 'error') gesture.toggle();
        return;
      }
      if (/d[eé]sactive.*cam[eé]ra|cam[eé]ra.*d[eé]sactive/.test(lower)) {
        if (gesture.gestureState === 'active') gesture.stop();
        return;
      }
      setVoiceConsoleQuery(text);
      setConsoleOpen(true);
    },
  });
  const [customShortcuts, setCustomShortcuts]  = useState<Record<string, string>>({});
  // Playlist: choice modal (video with &list= param) + import flow
  const [playlistChoice, setPlaylistChoice]    = useState<{ videoUrl: string; playlistUrl: string } | null>(null);
  useModalOpenTracking(!!playlistChoice);
  const [playlistImport, setPlaylistImport]    = useState<{ url: string; info: PlaylistInfo | null; loading: boolean } | null>(null);
  useModalOpenTracking(!!playlistImport);
  const [captureValue, setCaptureValue]        = useState('');
  const [captureBusy, setCaptureBusy]          = useState(false);
  const [capturePhase, setCapturePhase]        = useState<string | null>(null);
  const [pendingCaptureImgs, setPendingCaptureImgs] = useState<Array<{ id: string; previewUrl: string }>>([]);
  const [cvBusyId, setCvBusyId]                    = useState<string | null>(null);
  const [candidatureLetterReq, setCandidatureLetterReq] = useState<{ cvPageId: string; prefillContext?: string } | null>(null);
  useModalOpenTracking(!!candidatureLetterReq);
  const [cvRewriteModalReq, setCvRewriteModalReq]  = useState<{ sourcePageId: string } | null>(null);
  useModalOpenTracking(!!cvRewriteModalReq);
  const [cvAdaptModalReq,  setCvAdaptModalReq]     = useState<{ sourcePageId: string } | null>(null);
  useModalOpenTracking(!!cvAdaptModalReq);
  const [cvFreeQuestionModalReq, setCvFreeQuestionModalReq] = useState<{ sourcePageId: string } | null>(null);
  useModalOpenTracking(!!cvFreeQuestionModalReq);
  const [cvPdfImportOpen,  setCvPdfImportOpen]     = useState(false);
  useModalOpenTracking(cvPdfImportOpen);
  const [conflictRequest, setConflictRequest]  = useState<{ existingNeuron: Page; proposedParent: CaptureNeuron } | null>(null);
  useModalOpenTracking(!!conflictRequest);
  const [downloadUrl, setDownloadUrl]          = useState<string | null>(null);
  useModalOpenTracking(!!downloadUrl);
  const [downloadFolder, setDownloadFolder]    = useState<string>(() => localStorage.getItem('docteur.downloadFolder') ?? 'D:\\upload');
  // Batch processing
  const [batchSize,     setBatchSizeState]     = useState<number>(() => parseInt(localStorage.getItem('docteur.batchSize')  ?? '5',    10));
  const [batchDelay,    setBatchDelayState]    = useState<number>(() => parseInt(localStorage.getItem('docteur.batchDelay') ?? '1500', 10));
  const [batchProgress, setBatchProgress]      = useState<BatchProgressState | null>(null);
  useModalOpenTracking(!!batchProgress);
  const [batchMinimized, setBatchMinimized]    = useState(false);
  const [batchFailures, setBatchFailures]       = useState<Array<{ label: string; reason: string }> | null>(null);
  const [confirmBatch,  setConfirmBatch]        = useState<{ count: number; operation: string; estimatedMinutes: number; onConfirm: () => void } | null>(null);
  useModalOpenTracking(!!confirmBatch);
  const [whisperRequest, setWhisperRequest]     = useState<{ url: string; title: string; duration: number | null; groqAvailable: boolean } | null>(null);
  useModalOpenTracking(!!whisperRequest);
  const [whisperBatchChoice, setWhisperBatchChoice] = useState<{ ids: string[]; fromPlaylist?: boolean } | null>(null);
  useModalOpenTracking(!!whisperBatchChoice);
  const [whisperBatchStats, setWhisperBatchStats]   = useState<WhisperStats | null>(null);
  const [channelTranscribeRequest, setChannelTranscribeRequest] = useState<{ videoIds: string[] } | null>(null);
  useModalOpenTracking(!!channelTranscribeRequest);
  const [channelLimitInput, setChannelLimitInput]   = useState('');
  const [groqActive, setGroqActive]             = useState(false);
  const [whisperProgress, setWhisperProgress]   = useState<WhisperProgress | null>(null);
  const whisperAbortRef                         = useRef<AbortController | null>(null);
  const whisperProviderRef                      = useRef<'local' | 'groq' | null>(null);
  const [localNetworkIp, setLocalNetworkIp]     = useState<string | null>(null);
  const [showLocalBanner, setShowLocalBanner]   = useState(true);
  const [showHomeScreen, setShowHomeScreen]     = useState<boolean>(
    () => localStorage.getItem('docteur.showHomeScreen') !== 'false',
  );
  const [captureImages, setCaptureImages]       = useState<boolean>(
    () => localStorage.getItem('docteur.captureImages') === 'true',
  );
  const [transferImages, setTransferImages]     = useState<boolean>(
    () => localStorage.getItem('docteur.transferImages') === 'true',
  );

  const selectedPage   = pages.find(p => p.id === selectedId) ?? null;

  // Lazy-load full page content (blocks) when a page is selected
  useEffect(() => {
    if (selectedId) void loadPage(selectedId);
  }, [selectedId, loadPage]);

  const conflictResolveRef = useRef<((choice: ConflictChoice) => void) | null>(null);
  // Shared across EVERY capture entry point (batch, simple, pasted-text, Whisper) —
  // a per-call Map only dedupes within its own call, so a simple/paste/Whisper
  // capture running while a batch is in flight couldn't see the batch's
  // in-progress parent and created a duplicate. One persistent, session-long
  // Map fixes that regardless of which entry point runs concurrently.
  const batchParentsRef     = useRef<Map<string, string>>(new Map());
  const deepAbortRef        = useRef<AbortController | null>(null);
  const batchAbortRef       = useRef(false);
  const jobIdRef            = useRef('');
  const jobSyncTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ghost = pill restored from server after page reload (batch is dead, pill auto-dismisses)
  const ghostBatchRef       = useRef(false);
  const ghostTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Batch queue ────────────────────────────────────────────────────────────
  const [batchQueue, setBatchQueue]   = useState<QueuedJob[]>([]);
  const batchQueueRef                 = useRef<QueuedJob[]>([]);
  const batchProgressRef              = useRef<BatchProgressState | null>(null);
  // Total jobs started in the current session (resets when queue empties)
  const queueSessionRef               = useRef({ totalJobs: 0 });
  const batchMinimizedRef             = useRef(false);
  const lastPBPFlushRef               = useRef(0);

  // Keep batchQueueRef in sync for access from async callbacks
  useEffect(() => { batchQueueRef.current = batchQueue; }, [batchQueue]);
  useEffect(() => { batchMinimizedRef.current = batchMinimized; }, [batchMinimized]);

  // Sync batchProgress to server so TopBar indicator + reload persistence work
  useEffect(() => {
    batchProgressRef.current = batchProgress;
    if (!batchProgress) {
      // Batch ended — mark done and reset
      if (jobIdRef.current) {
        void cortexClient.finishJob(jobIdRef.current, '');
        jobIdRef.current = '';
      }
      if (jobSyncTimerRef.current) { clearTimeout(jobSyncTimerRef.current); jobSyncTimerRef.current = null; }
      // Ghost batch dismissed — don't reset minimized so pill disappears cleanly
      if (!ghostBatchRef.current) setBatchMinimized(false);
      return;
    }
    if (ghostBatchRef.current) return; // ghost batch — never re-register on server
    if (!jobIdRef.current) {
      // New batch — register on server
      cortexClient.startJob(batchProgress.operation, batchProgress.total)
        .then(id => { jobIdRef.current = id; })
        .catch(() => { /* non-critical */ });
    } else {
      // Debounced update every 2 s
      if (jobSyncTimerRef.current) clearTimeout(jobSyncTimerRef.current);
      jobSyncTimerRef.current = setTimeout(() => {
        cortexClient.updateJob(jobIdRef.current, {
          current:      batchProgress.current,
          currentLabel: batchProgress.currentLabel,
          okCount:      batchProgress.okCount,
          fallbackCount: batchProgress.fallbackCount,
          errorCount:   batchProgress.errorCount,
        }).then(found => {
          // Server no longer knows this job (e.g. cortex-server restarted
          // mid-batch — job tracking is in-memory only). The local batch
          // itself is unaffected and keeps running; just stop mirroring its
          // progress to a dead server-side id so the next tick doesn't
          // pointlessly retry it for the rest of a long batch.
          if (!found) jobIdRef.current = '';
        }).catch(() => { /* non-critical */ });
      }, 2_000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchProgress]);

  function handleBatchSizeChange(n: number) {
    setBatchSizeState(n);
    localStorage.setItem('docteur.batchSize', String(n));
  }
  function handleBatchDelayChange(ms: number) {
    setBatchDelayState(ms);
    localStorage.setItem('docteur.batchDelay', String(ms));
  }

  // ── Batch queue helpers ────────────────────────────────────────────────────

  // Start immediately if nothing is running; otherwise enqueue (max 10 slots).
  // Throttled setBatchProgress: when minimized, flushes at most once per 1.5 s
  // (except for null which always flushes to end the batch immediately).
  function setPBP(v: BatchProgressState | null | ((prev: BatchProgressState | null) => BatchProgressState | null)): void {
    if (v === null) {
      setBatchProgress(null);
      lastPBPFlushRef.current = 0;
      return;
    }
    if (!batchMinimizedRef.current) {
      setBatchProgress(v);
      return;
    }
    const now = Date.now();
    if (now - lastPBPFlushRef.current >= 1500) {
      setBatchProgress(v);
      lastPBPFlushRef.current = now;
    }
  }

  function enqueueOrStart(label: string, count: number, run: () => Promise<void>): void {
    if (batchProgressRef.current === null || ghostBatchRef.current) {
      queueSessionRef.current = { totalJobs: 1 };
      void run();
    } else if (batchQueueRef.current.length >= 10) {
      setToast('File pleine (max 10) — traitement non ajouté');
    } else {
      const pos = batchQueueRef.current.length + 2;
      queueSessionRef.current.totalJobs++;
      setBatchQueue(q => [...q, { id: generateId(), label, count, run }]);
      setToast(`Ajouté à la file (position ${pos})`);
    }
  }

  // Called at the end of every batch to auto-start the next queued job.
  function runNextInQueue(): void {
    const q = batchQueueRef.current;
    if (q.length === 0) {
      const { totalJobs } = queueSessionRef.current;
      if (totalJobs > 1) {
        setToast(`File terminée — ${totalJobs} traitement${totalJobs > 1 ? 's' : ''} exécuté${totalJobs > 1 ? 's' : ''}`);
      }
      queueSessionRef.current = { totalJobs: 0 };
      return;
    }
    const [next, ...rest] = q;
    batchQueueRef.current = rest;
    setBatchQueue(rest);
    setTimeout(() => { void next.run(); }, 150);
  }

  async function handleDownloadDone(result: DownloadResult): Promise<void> {
    setDownloadUrl(null);
    setCaptureValue('');

    if (result.mode === 'link_only') {
      // Use existing deep capture flow for the URL
      await captureFromInput(result.url);
      return;
    }

    // Build neuron content
    const hostname = (() => { try { return new URL(result.url).hostname.replace('www.', ''); } catch { return 'web'; } })();
    const channelTitle = hostname.charAt(0).toUpperCase() + hostname.slice(1);
    let content = result.url;
    if (result.filePath) content += `\n\nFichier local : ${result.filePath}`;
    if (result.analysis) content += `\n\n---\n\n${result.analysis}`;

    const childPage = await createPageFromData({
      title: result.title || 'Vidéo téléchargée',
      kind:  'video',
      blocks: createContentBlocks(content, result.title || 'Vidéo téléchargée'),
      metadata: { url: result.url, filePath: result.filePath ?? undefined, downloaded: true },
    });
    cortex.scheduleIndex(childPage);

    // Find or create channel (YouTube / Twitch / etc.)
    const existingChannel = pages.find(p => p.kind === 'channel' && normalizeTitle(p.title) === normalizeTitle(channelTitle));
    let channelId: string;
    if (existingChannel) {
      channelId = existingChannel.id;
    } else {
      const ch = await createPageFromData({ title: channelTitle, kind: 'channel', blocks: createContentBlocks(channelTitle, channelTitle) });
      cortex.scheduleIndex(ch);
      channelId = ch.id;
    }
    createLink(channelId, childPage.id);
    setSelectedId(childPage.id);
    setToast(`Vidéo téléchargée : ${result.title || 'OK'}`);
  }

  // Upload the image and add it to the pending strip — no neuron created yet.
  async function handleCaptureImagePaste(file: File) {
    const previewUrl = URL.createObjectURL(file);
    let imageId: string;
    try {
      const result = await cortexClient.uploadImage(file);
      imageId = result.id;
    } catch (err) {
      URL.revokeObjectURL(previewUrl);
      const msg = err instanceof Error ? err.message : 'Upload impossible';
      setToast(`Erreur image : ${msg}`);
      return;
    }
    setPendingCaptureImgs(prev => [...prev, { id: imageId, previewUrl }]);
  }

  // Remove one pending image: revoke blob URL + delete file from server.
  async function handleRemovePendingImage(id: string) {
    setPendingCaptureImgs(prev => {
      const img = prev.find(i => i.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter(i => i.id !== id);
    });
    try { await cortexClient.deleteImage(id); } catch { /* best-effort */ }
  }

  // Discard all pending images: revoke URLs + delete files from server.
  async function discardPendingCaptureImages() {
    const imgs = pendingCaptureImgs;
    for (const img of imgs) URL.revokeObjectURL(img.previewUrl);
    setPendingCaptureImgs([]);
    await Promise.allSettled(imgs.map(img => cortexClient.deleteImage(img.id)));
  }

  // Create a note neuron combining pending images + optional typed text.
  async function handleCaptureSubmitWithImages() {
    const text = captureValue.trim();
    const date = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const firstLine = text.split('\n').find(l => l.trim());
    const title = firstLine ? firstLine.trim().slice(0, 60) : `Image — ${date}`;
    const imageBlocks: Block[] = pendingCaptureImgs.map(img => ({
      id: generateId(), type: 'image' as const, content: img.id,
    }));
    const contentBlocks = text ? createContentBlocks(text, title) : [];
    const newPage = await createPageFromData({
      title,
      kind: 'note',
      blocks: [...imageBlocks, ...contentBlocks],
    });
    cortex.scheduleIndex(newPage);
    setSelectedId(newPage.id);
    for (const img of pendingCaptureImgs) URL.revokeObjectURL(img.previewUrl);
    setPendingCaptureImgs([]);
    setCaptureOpen(false);
    setCaptureValue('');
    const n = imageBlocks.length;
    setToast(`Neurone créé avec ${n} image${n > 1 ? 's' : ''}${text ? ' et du texte' : ''}`);
  }

  async function createNeuronFromCapture(payload: CaptureNeuron, extraBlocks: Block[] = []): Promise<Page> {
    const contentBlocks = createContentBlocks(String(payload.content ?? ''), payload.title || 'Sans titre');
    const page = await createPageFromData({
      title: payload.title || 'Sans titre',
      kind: (payload.kind as PageKind) ?? 'note',
      blocks: [...extraBlocks, ...(payload.blocks ?? []), ...contentBlocks],
      metadata: payload.metadata,
    });
    cortex.scheduleIndex(page);
    return page;
  }

  function showConflictModal(existingNeuron: Page, proposedParent: CaptureNeuron): Promise<ConflictChoice> {
    return new Promise(resolve => {
      conflictResolveRef.current = resolve;
      setConflictRequest({ existingNeuron, proposedParent });
    });
  }

  function resolveConflict(choice: ConflictChoice) {
    conflictResolveRef.current?.(choice);
    conflictResolveRef.current = null;
    setConflictRequest(null);
  }

  function findExistingNeuronByTitle(title: string): Page | undefined {
    const target = normalizeTitle(title);
    if (!target) return undefined;
    return pages.find(page => normalizeTitle(page.title) === target);
  }

  // batchParents: optional Map (normalized title → page id) shared across a batch
  // to avoid creating duplicate parents when React state hasn't reflected yet.
  async function applyCapturResponse(
    response: CaptureResult,
    batchParents?: Map<string, string>,
    extraChildBlocks: Block[] = [],
  ): Promise<void> {
    if (!response.parent) {
      const childPage = await createNeuronFromCapture(response.child, extraChildBlocks);
      setSelectedId(childPage.id);
      if (captureWarnsLimited(response)) setToast('Capture limitée, parent non identifié');
      return;
    }

    const normalKey      = normalizeTitle(response.parent.title);
    const batchCachedId  = batchParents?.get(normalKey);
    let parentId: string | null = null;

    if (batchCachedId) {
      // Parent already created earlier in this batch — reuse directly.
      parentId = batchCachedId;
    } else {
      const existing = findExistingNeuronByTitle(response.parent.title);
      if (!existing) {
        const newParent = await createNeuronFromCapture(response.parent);
        parentId = newParent.id;
        batchParents?.set(normalKey, parentId);
      } else if (existing.kind === 'channel') {
        parentId = existing.id;
        batchParents?.set(normalKey, existing.id);
      } else {
        const choice = await showConflictModal(existing, response.parent);
        if (choice === 'cancel') return;
        if (choice === 'reuse') {
          parentId = existing.id;
          batchParents?.set(normalKey, existing.id);
        } else {
          const renamedParent = await createNeuronFromCapture({
            ...response.parent,
            title: `${response.parent.title} (chaine)`,
          });
          parentId = renamedParent.id;
          batchParents?.set(normalKey, renamedParent.id);
        }
      }
    }

    const childPage = await createNeuronFromCapture(response.child, extraChildBlocks);
    if (parentId) createLink(parentId, childPage.id);
    setSelectedId(childPage.id);
    if (captureWarnsLimited(response)) setToast('Capture limitée, parent non identifié');
  }

  async function deepCaptureOne(
    url: string,
    ctrl: AbortController,
    label: string,
    batchParents: Map<string, string>,
    allowWhisper = false,
    extraChildBlocks: Block[] = [],
  ): Promise<'ok' | 'fallback' | 'abort' | 'needs_whisper'> {
    if (ctrl.signal.aborted) return 'abort';
    setCapturePhase(`${label} — Récupération…`);
    const phaseTimer = setTimeout(() => {
      if (!ctrl.signal.aborted) setCapturePhase(`${label} — Analyse…`);
    }, 5_000);
    const attemptCapture = async (): Promise<'ok' | 'fallback' | 'abort' | 'needs_whisper'> => {
      const response = await cortexClient.captureDeep(url, ctrl.signal, captureImages);
      clearTimeout(phaseTimer);
      if (ctrl.signal.aborted) return 'abort';
      if (response.fallback) {
        if (response.needs_whisper && allowWhisper) {
          setWhisperRequest({ url, title: response.title ?? '', duration: response.video_duration ?? null, groqAvailable: groqActive });
          return 'needs_whisper';
        }
        const simple = await cortexClient.capture(url);
        if (ctrl.signal.aborted) return 'abort';
        // Store the deep-capture failure reason on the neuron so the Sidebar can display it.
        if (response.reason && simple.child) {
          simple.child = {
            ...simple.child,
            metadata: { ...(simple.child.metadata ?? {}), capture_fallback_reason: response.reason },
          };
        }
        await applyCapturResponse(simple, batchParents, extraChildBlocks);
        return 'fallback';
      }
      setCapturePhase(`${label} — Création…`);
      await applyCapturResponse(response as unknown as CaptureResult, batchParents, extraChildBlocks);
      return 'ok';
    };

    try {
      return await attemptCapture();
    } catch (err) {
      clearTimeout(phaseTimer);
      if ((err as Error).name === 'AbortError' && ctrl.signal.aborted) return 'abort';
      // Retry once on network errors (ERR_CONNECTION_RESET from VRAM saturation)
      const msg = (err as Error).message ?? '';
      const isNetwork = !((err as Error).name === 'AbortError') &&
        (msg.includes('fetch') || msg.includes('network') || msg.includes('connection') ||
         msg.includes('ECONNRESET') || msg.includes('ERR_CONNECTION'));
      if (isNetwork) {
        try {
          await new Promise(r => setTimeout(r, 3_000));
          if (ctrl.signal.aborted) return 'abort';
          setCapturePhase(`${label} — Nouvelle tentative…`);
          return await attemptCapture();
        } catch {
          // retry also failed — fall through to fallback
        }
      } else {
        // Non-network error (e.g. server error, bad response): surface it explicitly
        setToast(`Erreur capture — ${msg || 'erreur inconnue'}`);
      }
      return 'fallback';
    }
  }

  // ── Batch runner for multi-URL deep capture ────────────────────────────────
  async function startDeepCaptureBatch(urls: string[]): Promise<void> {
    const total      = urls.length;
    const lotTotal   = Math.ceil(total / batchSize);
    const batchParents = batchParentsRef.current;
    let okCount = 0, fbCount = 0;
    const startedAt  = Date.now();

    const ctrl = new AbortController();
    deepAbortRef.current = ctrl;
    setCaptureBusy(true);
    batchAbortRef.current = false;

    try {
      for (let i = 0; i < total; i++) {
        if (ctrl.signal.aborted) break;

        const isLotBoundary = i > 0 && i % batchSize === 0;
        if (isLotBoundary) {
          // Finish-current-lot cancel check
          if (batchAbortRef.current) break;
          // Wait for indexing of the previous lot before starting a new one
          setBatchProgress(prev => prev ? { ...prev, currentLabel: 'Indexation du lot précédent…' } : null);
          await cortex.flushIndex();
          await new Promise(r => setTimeout(r, batchDelay));
          if (ctrl.signal.aborted || batchAbortRef.current) break;
        } else if (i > 0) {
          // Within-lot gap: lets Ollama release the nomic runner before next qwen call
          await new Promise(r => setTimeout(r, 1_200));
          if (ctrl.signal.aborted) break;
        }

        const url      = urls[i];
        const host     = (() => { try { return new URL(url).hostname; } catch { return url.slice(0, 30); } })();
        const lotIndex = Math.floor(i / batchSize) + 1;

        setBatchProgress({
          operation: 'Capture approfondie',
          current: i, total, lotIndex, lotTotal,
          currentLabel: host,
          okCount, fallbackCount: fbCount, errorCount: 0,
          startedAt,
        });

        const outcome = await deepCaptureOne(url, ctrl, host, batchParents);
        if (outcome === 'abort' || ctrl.signal.aborted) break;
        if (outcome === 'ok') okCount++;
        else                  fbCount++;

        setBatchProgress(prev => prev ? { ...prev, current: i + 1, okCount, fallbackCount: fbCount } : null);
      }

      // Flush any remaining index calls from the last lot
      await cortex.flushIndex();

      const aborted = ctrl.signal.aborted || batchAbortRef.current;
      if (aborted) {
        setToast(`Capture annulée — ${okCount + fbCount} neurones conservés`);
      } else {
        const parts: string[] = [];
        if (okCount > 0) parts.push(`${okCount} analyse${okCount > 1 ? 's' : ''} réussie${okCount > 1 ? 's' : ''}`);
        if (fbCount > 0) parts.push(`${fbCount} capture${fbCount > 1 ? 's' : ''} simple${fbCount > 1 ? 's' : ''}`);
        setToast(parts.join(', ') || 'Aucun neurone créé');
      }
    } finally {
      setBatchProgress(null);
      runNextInQueue();
      setCapturePhase(null);
      setCaptureBusy(false);
      deepAbortRef.current = null;
    }
  }

  // ── "seule" prefix: extract canonical playlist URLs, strip the keyword ───────
  function detectSeulePlaylists(raw: string): string[] | null {
    const trimmed = raw.trim();
    if (!/^seule\b/i.test(trimmed)) return null;

    // Strip "seule" from the start of every non-empty line (handles all three forms)
    const cleaned = trimmed
      .split('\n')
      .map(line => line.replace(/^\s*seule\s*/i, ''))
      .join('\n');

    const allUrls = extractUrls(cleaned);
    if (allUrls.length === 0) return null;

    const playlistUrls = allUrls.reduce<string[]>((acc, url) => {
      const d = detectPlaylistUrl(url);
      if (d) acc.push(d.playlistUrl);
      return acc;
    }, []);

    // No playlist URL → fall through to normal capture (seule + non-playlist link)
    return playlistUrls.length > 0 ? playlistUrls : null;
  }

  // ── Channel capture: create parent 'channel' neuron + light 'video' children ─
  async function doChannelCapture(channelUrl: string, info: PlaylistInfo): Promise<void> {
    const videos   = info.videos;
    const total    = videos.length;
    const startedAt = Date.now();

    batchAbortRef.current = false;
    setBatchProgress({
      operation:    'Chaine: 0/' + total,
      current:      0,
      total,
      lotIndex:     1,
      lotTotal:     total,
      currentLabel: info.title || info.uploader,
      okCount:      0,
      fallbackCount: 0,
      errorCount:   0,
      startedAt,
    });

    const channelContent = `${channelUrl}\n\n${total} vidéo${total !== 1 ? 's' : ''} · ${info.uploader}`;
    const channelPage = await createPageFromData({
      title:  info.title || info.uploader || 'Chaîne YouTube',
      kind:   'channel',
      blocks: createContentBlocks(channelContent, info.title || info.uploader),
      metadata: {
        url:          channelUrl,
        uploader:     info.uploader,
        playlistId:   info.playlistId,
        video_count:  total,
        captured_as:  'channel',
      },
    });
    cortex.scheduleIndex(channelPage);

    let okCount = 0, errCount = 0;
    const channelFailures: Array<{ label: string; reason: string }> = [];

    for (let i = 0; i < total; i++) {
      if (batchAbortRef.current) break;

      const v = videos[i];
      setPBP(prev => prev ? {
        ...prev,
        operation:    `Chaine: ${i}/${total}`,
        current:      i,
        lotIndex:     i + 1,
        currentLabel: v.title || v.url,
      } : null);

      try {
        const videoPage = await createPageFromData({
          title:  v.title || `Vidéo ${i + 1}`,
          kind:   'video',
          blocks: createContentBlocks(v.url, v.title || `Vidéo ${i + 1}`),
          metadata: { url: v.url, light: true, channelId: channelPage.id, videoId: v.id },
        });
        cortex.scheduleIndex(videoPage);
        createLink(channelPage.id, videoPage.id);
        okCount++;
        setPBP(prev => prev ? { ...prev, current: i + 1, okCount } : null);
      } catch (err) {
        errCount++;
        channelFailures.push({ label: v.title || v.url || `Vidéo ${i + 1}`, reason: (err as Error).message || 'Erreur inconnue' });
        setPBP(prev => prev ? { ...prev, current: i + 1, errorCount: errCount } : null);
      }

      if (i < total - 1 && !batchAbortRef.current) {
        await new Promise(r => setTimeout(r, 80));
      }
    }

    setBatchProgress(null);
    runNextInQueue();
    setSelectedId(channelPage.id);

    // Explicitly save the channel page with all accumulated links from React state.
    // createLink fires saves eagerly but each save only sees one link (stale lastRenderedState).
    // After a short delay React has re-rendered with all queued createLink updates,
    // so pagesRef.current has the complete links list.
    await new Promise(r => setTimeout(r, 120));
    const finalChannelPage = pagesRef.current.find(p => p.id === channelPage.id);
    if (finalChannelPage) savePage(finalChannelPage).catch(() => {});

    const aborted = batchAbortRef.current;
    const parts: string[] = [];
    if (aborted)     parts.push('Annulé —');
    if (okCount > 0) parts.push(`${okCount} vidéo${okCount !== 1 ? 's' : ''} archivée${okCount !== 1 ? 's' : ''}`);
    if (errCount > 0) parts.push(`${errCount} erreur${errCount !== 1 ? 's' : ''}`);
    setToast(parts.join(', ') || 'Aucune vidéo créée');
    if (channelFailures.length > 0) setBatchFailures(channelFailures);
  }

  async function startChannelCapture(channelUrl: string): Promise<void> {
    // Normalize to /videos tab so yt-dlp lists individual videos, not channel tabs
    const videosUrl = (() => {
      try {
        const u = new URL(channelUrl);
        const TAB_RE = /\/(featured|about|shorts|streams|playlists|community|membership|store|channels)\/?$/;
        const clean = u.pathname.replace(TAB_RE, '').replace(/\/$/, '');
        u.pathname = clean.endsWith('/videos') ? clean : clean + '/videos';
        u.search = '';
        return u.toString();
      } catch { return channelUrl; }
    })();

    setCaptureBusy(true);
    setCapturePhase('Chaîne — Récupération…');
    let info: PlaylistInfo;
    try {
      info = await cortexClient.getPlaylist(videosUrl);
    } catch {
      setToast('Impossible de récupérer les infos de la chaîne');
      return;
    } finally {
      setCapturePhase(null);
      setCaptureBusy(false);
    }

    const total = info.videos.length;
    if (total > 30) {
      setConfirmBatch({
        count:            total,
        operation:        'vidéos de la chaîne',
        estimatedMinutes: Math.max(1, Math.ceil(total * 0.1 / 60)),
        onConfirm:        () => { setConfirmBatch(null); enqueueOrStart(`Chaîne (${total} vidéos)`, total, () => doChannelCapture(channelUrl, info)); },
      });
    } else {
      enqueueOrStart(`Chaîne (${total} vidéos)`, total, () => doChannelCapture(channelUrl, info));
    }
  }

  // ── Deep analyze: enrich existing light video neurons sequentially ────────
  const LOCAL_WHISPER_LIMIT = 10;

  // Opens the provider-choice modal; actual batch runs after user picks a provider.
  async function deepAnalyzeNeurons(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    setWhisperBatchChoice({ ids });
  }

  // Runs the batch with a single, user-chosen Whisper provider for all videos.
  async function runDeepBatch(ids: string[], whisperProvider: 'local' | 'groq' | 'auto'): Promise<void> {
    const total     = ids.length;
    const startedAt = Date.now();
    batchAbortRef.current = false;
    const ctrl = new AbortController();
    deepAbortRef.current = ctrl;

    setBatchProgress({
      operation:     'Analyse en profondeur',
      current:       0,
      total,
      lotIndex:      1,
      lotTotal:      total,
      currentLabel:  '…',
      okCount:       0,
      fallbackCount: 0,
      errorCount:    0,
      startedAt,
    });

    let okCount = 0, fallbackCount = 0, errCount = 0, groqFallbackCount = 0;
    let autoGroqCount = 0, autoLocalCount = 0;
    const groqFallbackReasons: Record<string, number> = {};
    const deepBatchFailures: Array<{ label: string; reason: string }> = [];

    for (let i = 0; i < total; i++) {
      if (batchAbortRef.current || ctrl.signal.aborted) break;

      const pageId = ids[i];
      const page   = pages.find(p => p.id === pageId);
      if (!page) { deepBatchFailures.push({ label: pageId, reason: 'Page introuvable' }); errCount++; continue; }

      const url = typeof page.metadata?.url === 'string' ? page.metadata.url : '';
      if (!url) { deepBatchFailures.push({ label: page.title, reason: 'URL manquante dans les métadonnées' }); errCount++; continue; }

      setBatchProgress(prev => prev ? {
        ...prev, current: i, lotIndex: i + 1, currentLabel: page.title,
      } : null);

      try {
        const result = await cortexClient.captureDeep(url, ctrl.signal);
        if (ctrl.signal.aborted) break;

        if (!result.fallback && result.child) {
          const newBlocks = createContentBlocks(String(result.child.content ?? url), result.child.title || page.title);
          handleUpdatePage(pageId, {
            title:    result.child.title || page.title,
            blocks:   newBlocks,
            kind:     ((result.child.kind as PageKind) || 'video'),
            metadata: { ...page.metadata, ...(result.child.metadata ?? {}), light: false, deep_analyzed: true },
          });
          okCount++;
        } else if (result.needs_whisper) {
          const providerLabel = whisperProvider === 'groq' ? 'Groq Whisper'
            : whisperProvider === 'auto' ? 'Whisper auto'
            : 'Whisper local';
          const providerIcon = whisperProvider === 'groq' ? '⚡' : whisperProvider === 'auto' ? '🤖' : '🔒';
          setBatchProgress(prev => prev ? {
            ...prev,
            currentLabel: `${providerIcon} ${page.title} — ${providerLabel}`,
            whisperProvider: whisperProvider === 'groq' ? 'groq' : whisperProvider === 'local' ? 'local' : undefined,
          } : null);
          try {
            let lastSeenProvider: 'groq' | 'local' | null = null;
            const wResult = await cortexClient.captureDeepWhisper(
              url,
              (p) => {
                if (p.provider) lastSeenProvider = p.provider;
                const icon = p.provider === 'groq' ? '⚡' : p.provider === 'local' ? '🔒' : providerIcon;
                const label = p.groq_fallback
                  ? `⚠️ ${page.title} — Groq→local`
                  : `${icon} ${page.title} — ${p.label ?? providerLabel}`;
                setBatchProgress(prev => prev ? {
                  ...prev,
                  currentLabel: label,
                  whisperProvider: p.provider ?? prev.whisperProvider,
                } : null);
              },
              ctrl.signal,
              whisperProvider,
            );
            if (ctrl.signal.aborted) break;

            // Track Groq→local fallback with reason
            if (whisperProvider === 'groq' && wResult.groq_fallback) {
              groqFallbackCount++;
              const r = wResult.groq_fallback.reason ?? 'error';
              groqFallbackReasons[r] = (groqFallbackReasons[r] ?? 0) + 1;
            }
            // Track actual provider used in auto mode
            if (whisperProvider === 'auto' && lastSeenProvider) {
              if (lastSeenProvider === 'groq') autoGroqCount++;
              else autoLocalCount++;
            }

            if (!wResult.fallback && wResult.child) {
              const newBlocks = createContentBlocks(String(wResult.child.content ?? url), wResult.child.title || page.title);
              handleUpdatePage(pageId, {
                title:    wResult.child.title || page.title,
                blocks:   newBlocks,
                kind:     ((wResult.child.kind as PageKind) || 'video'),
                metadata: { ...page.metadata, ...(wResult.child.metadata ?? {}), light: false, deep_analyzed: true },
              });
              okCount++;
            } else {
              handleUpdatePage(pageId, { metadata: { ...page.metadata, light: false, deep_analyzed: true, fallback: true } });
              fallbackCount++;
            }
          } catch (wErr) {
            if ((wErr as Error).name === 'AbortError') break;
            deepBatchFailures.push({ label: page.title, reason: (wErr as Error).message || 'Erreur Whisper' });
            errCount++;
          } finally {
            setBatchProgress(prev => prev ? { ...prev, whisperProvider: undefined } : null);
          }
        } else {
          handleUpdatePage(pageId, {
            metadata: { ...page.metadata, light: false, deep_analyzed: true, fallback: true },
          });
          fallbackCount++;
        }
        setBatchProgress(prev => prev ? { ...prev, current: i + 1, okCount, fallbackCount } : null);
      } catch (err) {
        if ((err as Error).name === 'AbortError') break;
        deepBatchFailures.push({ label: page.title, reason: (err as Error).message || 'Erreur de capture' });
        errCount++;
        setBatchProgress(prev => prev ? { ...prev, current: i + 1, errorCount: errCount } : null);
      }

      if (i < total - 1 && !batchAbortRef.current) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    setBatchProgress(null);
    runNextInQueue();
    deepAbortRef.current = null;

    const parts: string[] = [];
    const groqOkCount = okCount - groqFallbackCount;
    if (whisperProvider === 'auto') {
      if (autoGroqCount > 0)   parts.push(`${autoGroqCount} via Groq`);
      if (autoLocalCount > 0)  parts.push(`${autoLocalCount} en local`);
      const autoOtherOk = okCount - autoGroqCount - autoLocalCount;
      if (autoOtherOk > 0)     parts.push(`${autoOtherOk} analysée${autoOtherOk !== 1 ? 's' : ''}`);
    } else if (whisperProvider === 'groq') {
      if (groqOkCount > 0)  parts.push(`${groqOkCount} via Groq`);
    } else {
      if (okCount > 0)      parts.push(`${okCount} analysée${okCount !== 1 ? 's' : ''}`);
    }
    if (fallbackCount > 0)      parts.push(`${fallbackCount} simplifiée${fallbackCount !== 1 ? 's' : ''}`);
    if (errCount > 0)           parts.push(`${errCount} erreur${errCount !== 1 ? 's' : ''}`);
    if (groqFallbackCount > 0) {
      const reasonLabels: Record<string, string> = { quota: 'quota', too_large: '>100 MB', no_key: 'clé manquante', error: 'erreur' };
      const reasons = Object.entries(groqFallbackReasons)
        .map(([r, n]) => `${n > 1 ? n + '× ' : ''}${reasonLabels[r] ?? r}`)
        .join(', ');
      parts.push(`${groqFallbackCount} Groq→local (${reasons})`);
    }
    if (okCount === 0 && fallbackCount === 0 && errCount === 0) {
      parts.push('Aucune vidéo analysée');
    }
    setToast(parts.join(' · ') || 'Analyse terminée');
    if (deepBatchFailures.length > 0) setBatchFailures(deepBatchFailures);
  }

  // ── Batch runner: create ONE playlist neuron per URL (no video children) ───
  async function startSeuleBatch(playlistUrls: string[]): Promise<void> {
    const total      = playlistUrls.length;
    const startedAt  = Date.now();
    let okCount = 0, skipCount = 0, errCount = 0;

    batchAbortRef.current = false;

    if (total > 1) {
      setBatchProgress({
        operation: 'Capture de playlists',
        current: 0, total,
        lotIndex: 1, lotTotal: total,
        currentLabel: '…',
        okCount: 0, fallbackCount: 0, errorCount: 0,
        startedAt,
      });
    }

    for (let i = 0; i < total; i++) {
      if (batchAbortRef.current) break;

      const url = playlistUrls[i];

      if (total > 1) {
        setBatchProgress(prev => prev ? {
          ...prev,
          current: i, lotIndex: i + 1,
          currentLabel: 'Récupération…',
        } : null);
      }

      try {
        const info = await cortexClient.getPlaylist(url);

        // Anti-duplicate: match by playlistId in metadata
        const alreadyExists = pages.some(
          p => p.kind === 'playlist' && p.metadata?.playlistId === info.playlistId,
        );
        if (alreadyExists) {
          skipCount++;
          if (total > 1) {
            setBatchProgress(prev => prev ? {
              ...prev, current: i + 1,
              currentLabel: `${info.title} (déjà existante)`,
              errorCount: skipCount + errCount,
            } : null);
          }
          continue;
        }

        if (total > 1) {
          setBatchProgress(prev => prev ? { ...prev, currentLabel: info.title } : null);
        }

        const page = await createPageFromData({
          title:  info.title,
          kind:   'playlist',
          blocks: createContentBlocks(
            `${url}\n\n${info.video_count} vidéo${info.video_count !== 1 ? 's' : ''} · ${info.uploader}`,
            info.title,
          ),
          metadata: {
            url,
            playlistId:    info.playlistId,
            uploader:      info.uploader,
            video_count:   info.video_count,
            captured_as:   'playlist_only',
          },
        });
        cortex.scheduleIndex(page);
        okCount++;

        if (total > 1) {
          setBatchProgress(prev => prev ? { ...prev, current: i + 1, okCount } : null);
        }

        // Small pause between requests so yt-dlp doesn't get rate-limited
        if (i < total - 1 && !batchAbortRef.current) {
          await new Promise(r => setTimeout(r, 600));
        }
      } catch {
        errCount++;
        if (total > 1) {
          setBatchProgress(prev => prev ? {
            ...prev, current: i + 1,
            errorCount: skipCount + errCount,
          } : null);
        }
      }
    }

    if (total > 1) setBatchProgress(null);
    runNextInQueue();

    const aborted = batchAbortRef.current;
    if (total === 1) {
      if (okCount === 1)     setToast('Playlist capturée (sans vidéos)');
      else if (skipCount > 0) setToast('Playlist ignorée — déjà présente dans Docteur');
      else                   setToast('Impossible de récupérer les infos de la playlist');
    } else {
      const parts: string[] = [];
      if (aborted)     parts.push('Annulé —');
      if (okCount > 0) parts.push(`${okCount} playlist${okCount > 1 ? 's' : ''} capturée${okCount > 1 ? 's' : ''}`);
      if (skipCount > 0) parts.push(`${skipCount} déjà existante${skipCount > 1 ? 's' : ''}`);
      if (errCount > 0)  parts.push(`${errCount} erreur${errCount > 1 ? 's' : ''}`);
      setToast(parts.join(', ') || 'Aucune playlist créée');
    }
  }

  async function captureFromInput(input: string, extraChildBlocks: Block[] = []): Promise<void> {
    const value = input.trim();
    if (!value || captureBusy) return;
    if (offline) {
      setToast('Capture indisponible hors-ligne — allumez le PC');
      return;
    }

    // ── PLUS TARD: add to todo list without capturing ─────────────────────────
    if (/^plus\s+tard\b/i.test(value)) {
      const rest = value.replace(/^plus\s+tard\s*/i, '').trim();
      if (!rest) { setToast('Précisez un lien ou une tâche après "plus tard"'); return; }
      let url: string | undefined;
      let title: string | undefined;
      let type: 'capture' | 'task' = 'task';
      let detected_kind: string | undefined;
      try {
        const parsed = new URL(rest);
        if (['http:', 'https:'].includes(parsed.protocol)) {
          url = rest;
          type = 'capture';
          if (rest.includes('youtube.com') || rest.includes('youtu.be')) {
            if (rest.includes('/playlist') || rest.includes('list=')) detected_kind = 'playlist';
            else if (rest.includes('/@') || rest.includes('/channel/') || rest.includes('/c/')) detected_kind = 'channel';
            else detected_kind = 'video';
          } else {
            detected_kind = 'article';
          }
        }
      } catch { /* not a URL */ }
      if (!url) { title = rest; type = 'task'; }
      try {
        await cortexClient.addTodo({ id: generateId(), type, url, title, detected_kind, priority: 0 });
        setTodoPendingCount(c => c + 1);
        setToast(`Ajouté à la liste "À faire"${url ? ' — ' + (detected_kind ?? '') : ''}`);
      } catch { setToast('Impossible d\'ajouter à la liste'); }
      setCaptureOpen(false);
      setCaptureValue('');
      return;
    }

    // ── CANDIDATURE: open letter modal ────────────────────────────────────────
    if (/^candidature\b/i.test(value)) {
      const context   = value.replace(/^candidature\s*/i, '').trim();
      const cvPages   = pages.filter(p => p.kind === 'cv');
      const firstCvId = cvPages.length > 0 ? cvPages[0].id : '';
      if (!firstCvId) { setToast('Aucun neurone CV trouvé — créez d\'abord un neurone de type CV'); return; }
      setCaptureOpen(false);
      setCaptureValue('');
      setCandidatureLetterReq({ cvPageId: firstCvId, prefillContext: context || undefined });
      return;
    }

    // ── CHAINE: YouTube channel capture (light video neurons) ────────────────
    const channelUrl = detectChannelUrl(value);
    if (channelUrl) {
      setCaptureOpen(false);
      setCaptureValue('');
      void startChannelCapture(channelUrl);
      return;
    }

    // ── SEULE: playlist-only capture (no video children) ─────────────────────
    const seulePlaylists = detectSeulePlaylists(value);
    if (seulePlaylists) {
      setCaptureOpen(false);
      setCaptureValue('');
      enqueueOrStart(`Playlists (${seulePlaylists.length})`, seulePlaylists.length, () => startSeuleBatch(seulePlaylists));
      return;
    }

    // "seule" prefix but no playlist URL → strip keyword, do normal capture
    if (/^seule\b/i.test(value)) {
      const stripped = value.split('\n').map(l => l.replace(/^\s*seule\s*/i, '')).join('\n').trim();
      if (stripped) { await captureFromInput(stripped, extraChildBlocks); }
      return;
    }

    const deepMatch = parseDeepInput(value);

    if (deepMatch) {
      // ── TÉLÉCHARGEMENT ────────────────────────────────────────────────────────
      if (deepMatch.mode === 'download') {
        setCaptureOpen(false);
        setDownloadUrl(deepMatch.url);
        return;
      }

      const ctrl = new AbortController();
      deepAbortRef.current = ctrl;
      setCaptureBusy(true);

      // ── TEXTE COLLÉ ─────────────────────────────────────────────────────────
      if (deepMatch.mode === 'paste') {
        try {
          setCapturePhase(`${deepMatch.source} — Analyse…`);
          const response = await cortexClient.captureDeepPaste(
            deepMatch.text,
            deepMatch.source,
            deepMatch.url,
            ctrl.signal,
          );
          if (!ctrl.signal.aborted) {
            setCapturePhase(`${deepMatch.source} — Création…`);
            await applyCapturResponse(response as unknown as CaptureResult, batchParentsRef.current, extraChildBlocks);
          }
        } catch (err) {
          if ((err as Error).name !== 'AbortError') setToast('Analyse impossible');
        } finally {
          setCapturePhase(null);
          setCaptureBusy(false);
          deepAbortRef.current = null;
          if (!ctrl.signal.aborted) { setCaptureOpen(false); setCaptureValue(''); }
        }
        return;
      }

      // ── DEEP CAPTURE URL (single ou batch) ──────────────────────────────────
      const urls  = deepMatch.urls;
      const total = urls.length;

      if (total === 1) {
        // Single URL: lightweight path — keep the CaptureModal open with phase text
        const batchParents = batchParentsRef.current;
        try {
          const url     = urls[0];
          const host    = (() => { try { return new URL(url).hostname; } catch { return url.slice(0, 30); } })();
          const outcome = await deepCaptureOne(url, ctrl, host, batchParents, true, extraChildBlocks);
          if (!ctrl.signal.aborted && outcome === 'fallback') {
            setToast(url.includes('youtube')
              ? 'Pas de transcription — capture simple effectuée'
              : 'Extraction impossible — capture simple effectuée');
          }
          // needs_whisper: modal is shown, capture modal closes, whisper takes over
          if (!ctrl.signal.aborted && outcome !== 'needs_whisper') { setCaptureOpen(false); setCaptureValue(''); }
          if (outcome === 'needs_whisper') { setCaptureOpen(false); setCaptureValue(''); }
        } catch (err) {
          if ((err as Error).name !== 'AbortError') setToast('Capture impossible');
        } finally {
          setCapturePhase(null);
          setCaptureBusy(false);
          deepAbortRef.current = null;
        }
      } else {
        // Multi-URL: hand off to the batch runner; close the capture modal first
        setCaptureBusy(false);
        deepAbortRef.current = null;
        setCaptureOpen(false);
        setCaptureValue('');

        const launch = () => { enqueueOrStart(`Capture (${total} liens)`, total, () => startDeepCaptureBatch(urls)); };
        if (total > 30) {
          setConfirmBatch({
            count: total,
            operation: 'articles',
            estimatedMinutes: Math.round(total * 45 / 60),
            onConfirm: () => { setConfirmBatch(null); launch(); },
          });
        } else {
          launch();
        }
      }
    } else {
      // ── PLAYLIST YOUTUBE ─────────────────────────────────────────────────────
      const playlistDetect = detectPlaylistUrl(value);
      if (playlistDetect) {
        setCaptureOpen(false);
        setCaptureValue('');
        if (playlistDetect.type === 'pure') {
          setPlaylistImport({ url: playlistDetect.playlistUrl, info: null, loading: true });
        } else {
          setPlaylistChoice({ videoUrl: value, playlistUrl: playlistDetect.playlistUrl });
        }
        return;
      }

      // ── SIMPLE CAPTURE ────────────────────────────────────────────────────────
      setCaptureBusy(true);
      try {
        const response = await cortexClient.capture(value);
        await applyCapturResponse(response, batchParentsRef.current, extraChildBlocks);
      } finally {
        setCaptureBusy(false);
      }
    }
  }

  // ── Page handlers ─────────────────────────────────────────────────────────

  const handleNewPage = useCallback(async (kind?: PageKind) => {
    try {
      const page = await createPage(kind ?? 'note');
      setSelectedId(page.id);
      cortexScheduleIndex(page);
    } catch (err) {
      setToast((err as Error).message ?? 'Impossible de créer le neurone');
    }
  }, [createPage, cortexScheduleIndex]);

  async function mergeDuplicateParents(): Promise<number> {
    // Group all channel pages by normalized title
    const groups = new Map<string, Page[]>();
    for (const page of pages) {
      if (page.kind !== 'channel') continue;
      const key = normalizeTitle(page.title);
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(page);
      groups.set(key, group);
    }

    let merged = 0;
    for (const [, group] of groups) {
      if (group.length <= 1) continue;
      // Keep the oldest (smallest createdAt)
      const keeper     = group.reduce((a, b) => a.createdAt <= b.createdAt ? a : b);
      const duplicates = group.filter(p => p.id !== keeper.id);

      for (const dup of duplicates) {
        // Find all pages linked to this duplicate and relink to keeper
        const children = pages.filter(p => p.id !== dup.id && (p.links ?? []).includes(dup.id));
        for (const child of children) {
          removeLink(dup.id, child.id);
          createLink(keeper.id, child.id);
        }
        await removePage(dup.id);
        cortex.scheduleDelete(dup.id);
        merged++;
      }
    }
    return merged;
  }

  const handleUpdatePage = useCallback(
    (id: string, updates: Partial<Omit<Page, 'id' | 'createdAt'>>) => {
      void updatePage(id, updates).then(current => {
        if (current) cortexScheduleIndex(current);
      }).catch(error => setToast(String(error.message)));
    },
    [updatePage, cortexScheduleIndex],
  );

  const REVIEW_SEP = '--- RELECTURE CRITIQUE (IA,';

  const handleReviewPage = useCallback(async (page: Page) => {
    setReviewingId(page.id);
    setToast('Relecture en cours…');
    try {
      const content = pageToContent(page);
      const result  = await cortexClient.reviewResearch(content);
      const date    = new Date().toLocaleDateString('fr-FR');

      // Remove any existing review blocks to avoid stacking
      const reviewIdx = page.blocks.findIndex(b => b.content.startsWith(REVIEW_SEP));
      const baseBlocks = reviewIdx >= 0 ? page.blocks.slice(0, reviewIdx) : page.blocks;

      const separatorBlock: Block = {
        id:      generateId(),
        type:    'paragraph',
        content: `${REVIEW_SEP} ${date}) — modèle : ${result.model} ---`,
      };
      const reviewBlocks = createContentBlocks(result.review, 'Relecture');
      handleUpdatePage(page.id, { blocks: [...baseBlocks, separatorBlock, ...reviewBlocks] });

      const modelLabel = result.model === 'local' ? 'modèle local' : result.model;
      setToast(`Relecture ajoutée · ${modelLabel}`);
    } catch (e) {
      setToast(`Relecture échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setReviewingId(null);
    }
  }, [handleUpdatePage]);

  const handleRegenerateVeille = useCallback(async (page: Page, level: DetailLevel) => {
    const subject = typeof page.metadata?.subject === 'string' ? page.metadata.subject : page.title;
    const sources = Array.isArray(page.metadata?.sources) ? page.metadata.sources as ResearchSource[] : [];
    setRegeneratingId(page.id);
    setToast(`Régénération en cours (${DETAIL_LEVEL_LABELS[level]})…`);
    try {
      const result = await cortexClient.regenerateVeille(subject, level, sources);
      void cortexClient.setVeilleSettings(level).catch(() => null);
      const date = new Date().toLocaleDateString('fr-FR');
      let content = result.content;
      if (sources.length > 0) {
        content += '\n\n---\n**Sources (réutilisées, sans nouvelle recherche web) :**\n' +
          sources.map(s => `- [${s.title}](${s.url})`).join('\n');
      }
      content += `\n\n---\n*Régénéré par IA (${result.model}) le ${date} — niveau ${DETAIL_LEVEL_LABELS[level]}.*`;
      const newPage = await createPageFromData({
        title:  `${page.title} — ${DETAIL_LEVEL_LABELS[level]}`,
        kind:   'recherche',
        blocks: createContentBlocks(content, subject),
        metadata: { subject, detailLevel: level, sources },
      });
      createLink(page.id, newPage.id);
      cortex.scheduleIndex(newPage);
      setSelectedId(newPage.id);
      setToast(`Neurone régénéré · ${DETAIL_LEVEL_LABELS[level]}`);
    } catch (e) {
      setToast(`Régénération échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setRegeneratingId(null);
    }
  }, [createPageFromData, createLink, cortex]);

  const RESUMMARISE_SEP = '--- RÉSUMÉ PRÉCÉDENT (';

  function handleResummariseDone(pageId: string, summary: string, modelUsed: string) {
    setResummariseId(null);
    const page = pagesRef.current.find(p => p.id === pageId);
    if (!page) return;
    const date = new Date().toLocaleDateString('fr-FR');

    // Remove any previously archived summary to avoid stacking
    const prevIdx    = page.blocks.findIndex(b => b.content.startsWith(RESUMMARISE_SEP));
    const baseBlocks = prevIdx >= 0 ? page.blocks.slice(0, prevIdx) : page.blocks;

    const newSummaryBlocks = createContentBlocks(summary, page.title);
    const archiveSep: Block = {
      id:      generateId(),
      type:    'paragraph',
      content: `${RESUMMARISE_SEP}${date}) — modèle : ${modelUsed} ---`,
    };
    handleUpdatePage(pageId, {
      blocks:   [...newSummaryBlocks, archiveSep, ...baseBlocks],
      metadata: { ...(page.metadata ?? {}), model_used: modelUsed },
    });
    setToast(`Résumé régénéré · ${modelUsed}`);
  }

  // ── Compare: save handlers ─────────────────────────────────────────────────

  async function handleCompareSaveResponse(question: string, answer: string, _modelId: string, modelUsed: string): Promise<void> {
    const date = new Date().toLocaleDateString('fr-FR');
    const content = `**Réponse (${modelUsed}) :**\n${answer}\n\n---\n**Modèle :** ${modelUsed}\n**Date :** ${date}`;
    const page = await createPageFromData({
      title:  question,
      kind:   'question',
      blocks: createContentBlocks(content, question),
    });
    cortex.scheduleIndex(page);
    setSelectedId(page.id);
  }

  async function handleCompareSaveComparison(question: string, results: import('./lib/cortex/client').CompareModelResult[]): Promise<void> {
    const date = new Date().toLocaleDateString('fr-FR');
    let content = `**Question :** ${question}\n**Date :** ${date}\n\n---\n\n`;
    for (const r of results) {
      content += `## ${r.model_used} (${r.provider})\n\n${r.answer}\n\n`;
      content += `*${(r.latency_ms / 1000).toFixed(1)}s · ${r.sources.length} neurone${r.sources.length !== 1 ? 's' : ''}*\n\n---\n\n`;
    }
    const page = await createPageFromData({
      title:  `Comparaison — ${question.slice(0, 60)}`,
      kind:   'question',
      blocks: createContentBlocks(content, question),
    });
    cortex.scheduleIndex(page);
    setSelectedId(page.id);
    setToast(`Comparaison sauvegardée · ${results.length} modèles`);
  }

  // Creates a neuron from an agent run output (manual or pending scheduled output)
  const handleAgentOutput = useCallback(async (output: { title: string; content: string; kind: string; run_id?: string; id?: string }) => {
    const newPage = await createPageFromData(agentPageData(output));
    cortexScheduleIndex(newPage);
    setSelectedId(newPage.id);
    // If this was a scheduled output, mark it consumed
    if (output.id) {
      cortexClient.consumeAgentOutput(output.id, newPage.id).catch(() => {});
    }
    return newPage;
  }, [createPageFromData, cortexScheduleIndex]);

  // On mount, pick up any inbox files processed at startup
  useEffect(() => {
    if (!cortex.available) return;
    cortexClient.getInboxPending().then(async (pending) => {
      if (pending.length === 0) return;
      let count = 0;
      for (const item of pending) {
        try {
          await handleAgentOutput({ title: item.title, content: item.content, kind: 'rapport' });
          cortexClient.consumeInboxPending(item.id).catch(() => {});
          count++;
        } catch { /* non-fatal */ }
      }
      if (count > 0) setToast(`${count} rapport${count > 1 ? 's' : ''} importé${count > 1 ? 's' : ''} depuis le dossier surveillé.`);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cortex.available]);

  // On mount, pick up any pending outputs from scheduled agent runs
  useEffect(() => {
    if (!cortex.available) return;
    cortexClient.getPendingAgentOutputs().then(outputs => {
      if (outputs.length === 0) return;
      (async () => {
        for (const out of outputs) {
          try { await handleAgentOutput(out); } catch { /* non-fatal */ }
        }
        setToast(`${outputs.length} neurone${outputs.length > 1 ? 's' : ''} créé${outputs.length > 1 ? 's' : ''} par agents planifiés.`);
      })();
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cortex.available]);

  const handleCvPdfImport = useCallback(async (file: File) => {
    const result = await cortexClient.importCvFromPdf(file);
    const title  = result.title || file.name.replace(/\.pdf$/i, '') || 'CV importé';
    const newPage = await createPage('cv');
    const blocks: Block[] = [
      { id: generateId(), type: 'h1',        content: title },
      { id: generateId(), type: 'paragraph', content: `Importé depuis "${file.name}" · ${result.pages_count} page${result.pages_count !== 1 ? 's' : ''} · 🔒 100% local` },
      { id: generateId(), type: 'paragraph', content: '──────────────────────────────' },
      ...result.text.split('\n\n').filter(s => s.trim()).map(s => ({
        id:      generateId(),
        type:    'paragraph' as const,
        content: s.trim(),
      })),
    ];
    handleUpdatePage(newPage.id, { title, blocks, kind: 'cv', private: true });
    setSelectedId(newPage.id);
    setToast(`CV importé · ${result.pages_count} page${result.pages_count !== 1 ? 's' : ''} · neurone privé créé`);
  }, [createPageFromData, cortexScheduleIndex]);

  const handleCvAnalyze = useCallback(async (page: Page, powerful = false) => {
    setCvBusyId(page.id);
    setToast(powerful ? 'Analyse CV (modèle puissant)…' : 'Analyse CV en cours…');
    try {
      const cvContent = pageToContent(page);
      const result    = await cortexClient.cvAnalyze(cvContent, powerful);
      const date      = new Date().toLocaleDateString('fr-FR');
      const reportPage = await createPage('candidature');
      const titleStr  = `Analyse CV — ${page.title} — ${date}`;
      const reportBlocks: Block[] = [
        { id: generateId(), type: 'h1',       content: titleStr },
        { id: generateId(), type: 'paragraph', content: `Modèle utilisé : ${result.model_used} · 100% local` },
        ...createContentBlocks(result.report, 'Analyse CV'),
      ];
      // kind 'candidature' + private:true — this report quotes the CV verbatim
      // (interview questions, weak points) and must get the same automatic
      // cloud-exclusion as every other CV-derived neuron (rewrite, target-jobs,
      // ats-keywords, master-cv, adapt-cv already did this; analyze was the
      // one outlier, created as a plain 'note' with no privacy protection).
      handleUpdatePage(reportPage.id, { title: titleStr, blocks: reportBlocks, kind: 'candidature', private: true });
      createLink(page.id, reportPage.id);
      setSelectedId(reportPage.id);
      setToast(`Analyse complète · ${result.model_used}`);
    } catch (e) {
      setToast(`Analyse échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setCvBusyId(null);
    }
  }, [handleUpdatePage, createPage, createLink]);

  const handleCvLetter = useCallback(async (params: { cvPageId: string; format: 'email' | 'lettre'; mode: 'generique' | 'ciblee'; company?: string; jobTitle?: string; jobOffer?: string; powerful: boolean }) => {
    const cvPage = pages.find(p => p.id === params.cvPageId);
    if (!cvPage) { setToast('Neurone CV introuvable'); return; }
    setToast(params.powerful ? 'Génération lettre (modèle puissant)…' : 'Génération lettre en cours…');
    try {
      const cvContent = pageToContent(cvPage);
      const result    = await cortexClient.cvLetter({ cvContent, format: params.format, mode: params.mode, company: params.company, jobTitle: params.jobTitle, jobOffer: params.jobOffer, powerful: params.powerful });
      const letterPage = await createPage('candidature');
      const titleStr   = result.title || `Lettre — ${cvPage.title}`;
      const letterBlocks: Block[] = [
        { id: generateId(), type: 'h1',        content: titleStr },
        { id: generateId(), type: 'paragraph', content: `Généré par Docteur · ${result.model_used} · 100% local` },
        ...createContentBlocks(result.letter, 'Lettre'),
      ];
      handleUpdatePage(letterPage.id, { title: titleStr, blocks: letterBlocks, kind: 'candidature' });
      createLink(cvPage.id, letterPage.id);
      setSelectedId(letterPage.id);
      setToast(`Lettre générée · ${result.model_used}`);
    } catch (e) {
      setToast(`Génération échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
    }
  }, [pages, handleUpdatePage, createPage, createLink]);

  const handleCvRewrite = useCallback(async (
    page: Page,
    opts: { targetJob?: string; jobOffer?: string; powerful?: boolean } = {},
  ) => {
    setCvBusyId(page.id);
    const targeted = !!(opts.targetJob || opts.jobOffer);
    setToast(opts.powerful ? 'Réécriture CV (modèle puissant)…' : targeted ? 'Réécriture ciblée en cours…' : 'Réécriture CV en cours…');
    try {
      const cvContent = pageToContent(page);
      const result    = await cortexClient.cvRewrite({
        cvContent,
        targetJob: opts.targetJob,
        jobOffer:  opts.jobOffer,
        powerful:  opts.powerful,
      });
      const date     = new Date().toLocaleDateString('fr-FR');
      const newPage  = await createPage('cv');
      const suffix   = opts.targetJob ? ` → ${opts.targetJob}` : '';
      const titleStr = `${page.title} (réécrit ${date}${suffix})`;

      const newBlocks: Block[] = [
        { id: generateId(), type: 'h1',        content: titleStr },
        { id: generateId(), type: 'paragraph', content: `Réécriture par Docteur · ${result.model_used} · 100% local · original : "${page.title}"${targeted ? ` · ciblé : ${opts.targetJob ?? 'offre collée'}` : ''}` },
        { id: generateId(), type: 'paragraph', content: '──────────────────────────────' },
        ...createContentBlocks(result.rewritten_cv, 'CV réécrit'),
      ];

      if (result.changes?.trim()) {
        newBlocks.push(
          { id: generateId(), type: 'h2',        content: 'Changements effectués' },
          ...createContentBlocks(result.changes, 'Changements'),
        );
      }

      handleUpdatePage(newPage.id, { title: titleStr, blocks: newBlocks, kind: 'cv', private: true });
      createLink(page.id, newPage.id);
      setSelectedId(newPage.id);
      setToast(`CV réécrit · ${result.model_used}`);
    } catch (e) {
      setToast(`Réécriture échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setCvBusyId(null);
    }
  }, [handleUpdatePage, createPage, createLink]);

  const handleCvTargetJobs = useCallback(async (page: Page) => {
    setCvBusyId(page.id);
    setToast('Analyse des postes cibles en cours…');
    try {
      const cvContent = pageToContent(page);
      const result    = await cortexClient.cvTargetJobs(cvContent);
      const date      = new Date().toLocaleDateString('fr-FR');
      const newPage   = await createPage('candidature');
      const titleStr  = `Postes cibles — ${page.title} — ${date}`;
      const blocks: Block[] = [
        { id: generateId(), type: 'h1',       content: titleStr },
        { id: generateId(), type: 'paragraph', content: `🔒 100% local · ${result.model_used}` },
        { id: generateId(), type: 'paragraph', content: '──────────────────────────────' },
        ...createContentBlocks(result.report, 'Postes cibles'),
      ];
      handleUpdatePage(newPage.id, { title: titleStr, blocks, kind: 'candidature', private: true });
      createLink(page.id, newPage.id);
      setSelectedId(newPage.id);
      setToast(`Postes cibles générés · ${result.model_used}`);
    } catch (e) {
      setToast(`Erreur : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setCvBusyId(null);
    }
  }, [handleUpdatePage, createPage, createLink]);

  const handleCvAtsKeywords = useCallback(async (page: Page) => {
    setCvBusyId(page.id);
    setToast('Analyse des mots-clés ATS en cours…');
    try {
      const cvContent = pageToContent(page);
      const result    = await cortexClient.cvAtsKeywords(cvContent);
      const date      = new Date().toLocaleDateString('fr-FR');
      const newPage   = await createPage('candidature');
      const titleStr  = `Mots-clés ATS — ${page.title} — ${date}`;
      const blocks: Block[] = [
        { id: generateId(), type: 'h1',       content: titleStr },
        { id: generateId(), type: 'paragraph', content: `🔒 100% local · ${result.model_used}` },
        { id: generateId(), type: 'paragraph', content: '──────────────────────────────' },
        ...createContentBlocks(result.report, 'Mots-clés ATS'),
      ];
      handleUpdatePage(newPage.id, { title: titleStr, blocks, kind: 'candidature', private: true });
      createLink(page.id, newPage.id);
      setSelectedId(newPage.id);
      setToast(`Mots-clés ATS générés · ${result.model_used}`);
    } catch (e) {
      setToast(`Erreur : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setCvBusyId(null);
    }
  }, [handleUpdatePage, createPage, createLink]);

  const handleCvMasterCv = useCallback(async (page: Page) => {
    setCvBusyId(page.id);
    setToast('Génération du CV master en cours…');
    try {
      const cvContent = pageToContent(page);
      const result    = await cortexClient.cvMasterCv(cvContent);
      const date      = new Date().toLocaleDateString('fr-FR');
      const newPage   = await createPage('cv');
      const titleStr  = `CV Master — ${page.title} — ${date}`;
      const blocks: Block[] = [
        { id: generateId(), type: 'h1',       content: titleStr },
        { id: generateId(), type: 'paragraph', content: `🔒 100% local · ${result.model_used} · version complète modulaire` },
        { id: generateId(), type: 'paragraph', content: '──────────────────────────────' },
        ...createContentBlocks(result.master_cv, 'CV Master'),
      ];
      if (result.guide?.trim()) {
        blocks.push(
          { id: generateId(), type: 'h2',       content: 'Guide de déclinaison' },
          ...createContentBlocks(result.guide, 'Guide'),
        );
      }
      handleUpdatePage(newPage.id, { title: titleStr, blocks, kind: 'cv', private: true });
      createLink(page.id, newPage.id);
      setSelectedId(newPage.id);
      setToast(`CV master généré · ${result.model_used}`);
    } catch (e) {
      setToast(`Erreur : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setCvBusyId(null);
    }
  }, [handleUpdatePage, createPage, createLink]);

  const handleCvAdaptCv = useCallback(async (page: Page, jobOffer: string, powerful = false) => {
    setCvBusyId(page.id);
    setToast('Adaptation du CV à l\'offre en cours…');
    try {
      const masterCvContent = pageToContent(page);
      const result          = await cortexClient.cvAdaptCv({ masterCvContent, jobOffer, powerful });
      const date            = new Date().toLocaleDateString('fr-FR');
      const newPage         = await createPage('candidature');
      const titleStr        = `CV adapté — ${page.title} — ${date}`;
      const blocks: Block[] = [
        { id: generateId(), type: 'h1',       content: titleStr },
        { id: generateId(), type: 'paragraph', content: `🔒 100% local · ${result.model_used}` },
        { id: generateId(), type: 'paragraph', content: `Score d'adéquation : ${result.adequation_score}` },
        { id: generateId(), type: 'paragraph', content: '──────────────────────────────' },
        ...createContentBlocks(result.adapted_cv, 'CV adapté'),
      ];
      if (result.missing?.trim()) {
        blocks.push(
          { id: generateId(), type: 'h2',       content: 'Ce qui manque pour ce poste' },
          ...createContentBlocks(result.missing, 'Manques'),
        );
      }
      if (result.keywords_used?.trim()) {
        blocks.push(
          { id: generateId(), type: 'h2',       content: 'Mots-clés de l\'offre intégrés' },
          ...createContentBlocks(result.keywords_used, 'Mots-clés'),
        );
      }
      handleUpdatePage(newPage.id, { title: titleStr, blocks, kind: 'candidature', private: true });
      createLink(page.id, newPage.id);
      setSelectedId(newPage.id);
      setToast(`CV adapté · ${result.adequation_score} · ${result.model_used}`);
    } catch (e) {
      setToast(`Erreur : ${e instanceof Error ? e.message : 'Erreur'}`);
    } finally {
      setCvBusyId(null);
    }
  }, [handleUpdatePage, createPage, createLink]);

  const handleCvFreeQuestionAsk = useCallback(async (
    page: Page,
    params: { question: string; chainHistory: { question: string; answer: string }[]; powerful: boolean },
  ) => {
    const cvContent = pageToContent(page);
    return cortexClient.cvFreeQuestion({
      cvContent,
      question:     params.question,
      chainHistory: params.chainHistory,
      powerful:     params.powerful,
    });
  }, []);

  const handleCvFreeQuestionSave = useCallback(async (
    page: Page,
    params: { question: string; answer: string; modelUsed: string },
  ) => {
    const date      = new Date().toLocaleDateString('fr-FR');
    const newPage   = await createPage('candidature');
    const titleStr  = `Question libre — ${page.title} — ${date}`;
    const blocks: Block[] = [
      { id: generateId(), type: 'h1',        content: titleStr },
      { id: generateId(), type: 'paragraph', content: `🔒 100% local · ${params.modelUsed}` },
      { id: generateId(), type: 'h2',        content: 'Question' },
      ...createContentBlocks(params.question, 'Question'),
      { id: generateId(), type: 'h2',        content: 'Réponse' },
      ...createContentBlocks(params.answer, 'Réponse'),
    ];
    handleUpdatePage(newPage.id, { title: titleStr, blocks, kind: 'candidature', private: true });
    createLink(page.id, newPage.id);
    setToast('Résultat sauvegardé');
  }, [handleUpdatePage, createPage, createLink]);

  const handleRestorePages = useCallback(async (
    neurons: BackupExport['neurons'],
    links: Array<{ from: string; to: string }>,
  ) => {
    for (const n of neurons) {
      // Full-fidelity restore: use the real blocks when the backup has them
      // (version ≥1.2), never flatten through upsertPage's single-paragraph
      // reconstruction — that's what silently emptied the editor before.
      const blocks = Array.isArray(n.blocks) && n.blocks.length > 0
        ? n.blocks
        : (n.content?.trim() ? [{ id: generateId(), type: 'paragraph' as const, content: n.content }] : []);

      const exists = pages.some(p => p.id === n.id);
      if (exists) {
        updatePage(n.id, {
          title: n.title, kind: n.kind as PageKind, blocks,
          links: n.links, color: n.color, tags: n.tags, metadata: n.metadata, private: n.private,
        });
      } else {
        await createPageFromData({
          id: n.id, title: n.title, kind: n.kind as PageKind, blocks,
          createdAt: n.createdAt, updatedAt: n.updatedAt,
          links: n.links, color: n.color, tags: n.tags, metadata: n.metadata, private: n.private,
        });
      }
    }
    // Recreate synapses — createLink is idempotent (deduplicates internally)
    for (const link of links) {
      createLink(link.from, link.to);
    }
  }, [pages, createPageFromData, updatePage, createLink]);

  // ── Whisper transcription ─────────────────────────────────────────────────

  async function handleWhisperConfirm(url: string, provider: 'local' | 'groq' | 'auto' = 'local') {
    const ctrl = new AbortController();
    whisperAbortRef.current = ctrl;
    whisperProviderRef.current = null;
    setWhisperRequest(null);
    setWhisperProgress({ step: 'download', percent: 0, label: 'Téléchargement audio…' });
    try {
      const result = await cortexClient.captureDeepWhisper(url, (p) => {
        if (p.provider) whisperProviderRef.current = p.provider;
        setWhisperProgress(prev => ({ ...prev, ...p, provider: whisperProviderRef.current ?? p.provider }));
      }, ctrl.signal, provider);
      if (ctrl.signal.aborted) return;
      if (result.fallback) {
        setToast(`Transcription échouée : ${result.error ?? result.reason ?? 'Erreur'}`);
        return;
      }
      if (!result.child) { setToast('Résultat vide'); return; }
      await applyCapturResponse(result as unknown as CaptureResult, batchParentsRef.current);
      setToast(`Transcription Whisper ${provider === 'groq' ? 'Groq ' : provider === 'auto' ? '(auto) ' : ''}terminée`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setToast(`Whisper : ${(err as Error).message}`);
      }
    } finally {
      setWhisperProgress(null);
      whisperAbortRef.current = null;
      whisperProviderRef.current = null;
    }
  }

  // ── Playlist import ───────────────────────────────────────────────────────

  const startPlaylistImport = useCallback(async (playlistUrl: string) => {
    setPlaylistImport({ url: playlistUrl, info: null, loading: true });
  }, []);

  useEffect(() => {
    if (!playlistImport?.loading || playlistImport.info !== null) return;
    let cancelled = false;

    cortexClient.getPlaylist(playlistImport.url).then(info => {
      if (!cancelled) setPlaylistImport(prev => prev ? { ...prev, info, total: info.video_count, loading: false } : null);
    }).catch(err => {
      if (!cancelled) {
        setToast(`Playlist : ${(err as Error).message}`);
        setPlaylistImport(null);
      }
    });

    return () => { cancelled = true; };
  }, [playlistImport?.loading, playlistImport?.url, playlistImport?.info]);

  // Fetch local IP from health endpoint (available when LOCAL_NETWORK=true)
  useEffect(() => {
    cortexClient.health().then(h => {
      const ip = (h as Record<string, unknown>).local_ip as string | null;
      if (ip) setLocalNetworkIp(ip);
    }).catch(() => {});
    cortexClient.getCloudKeys().then(k => setGroqActive(k.groq_active)).catch(() => {});
    cortexClient.getTodos().then(items => setTodoPendingCount(items.filter(i => i.status === 'pending').length)).catch(() => {});
    // Check for jobs that were running before a page reload — restore ghost pill
    cortexClient.getJobs().then(jobs => {
      const running = jobs.filter(j => j.status === 'running');
      if (running.length === 0) return;
      const j = running[0];
      // Mark stale job done on server (batch is dead after reload)
      void cortexClient.finishJob(j.id, 'interrompu au rechargement', 'error');
      // Restore a ghost pill in the TopBar so the user sees the last state
      ghostBatchRef.current = true;
      setBatchProgress({
        operation:    j.operation,
        current:      j.current,
        total:        j.total,
        lotIndex:     j.current,
        lotTotal:     j.total,
        currentLabel: '— traitement interrompu au rechargement',
        okCount:      j.okCount,
        fallbackCount: j.fallbackCount,
        errorCount:   j.errorCount,
        startedAt:    j.startedAt,
      });
      setBatchMinimized(true); // show as pill, not blocking panel
      setToast(`⚠ "${j.operation}" interrompu — ${j.current}/${j.total} traités avant rechargement`);
      // Auto-dismiss ghost pill after 20 s
      ghostTimerRef.current = setTimeout(() => {
        ghostBatchRef.current = false;
        setBatchProgress(null);
      }, 20_000);
    }).catch(() => {});
  }, []);

  // Abort any in-flight deep-capture / whisper on unmount (edge case — App rarely unmounts)
  useEffect(() => () => {
    deepAbortRef.current?.abort();
    whisperAbortRef.current?.abort();
    if (ghostTimerRef.current) clearTimeout(ghostTimerRef.current);
  }, []);

  const handlePlaylistConfirm = useCallback(() => {
    if (!playlistImport?.info) return;
    const { info, url } = playlistImport;
    const videos = info.videos;
    const total  = videos.length;

    // Close the playlist modal immediately — the batch will run now or when queued
    setPlaylistImport(null);

    const runBatch = async () => {
      const lotTotal = Math.ceil(total / batchSize);

      // Find or create playlist neuron
      const normalTitle = normalizeTitle(info.title);
      let playlistPage = pages.find(p => p.kind === 'playlist' && normalizeTitle(p.title) === normalTitle);
      if (!playlistPage) {
        playlistPage = await createPageFromData({
          title:  info.title,
          kind:   'playlist',
          blocks: createContentBlocks(`${url}\n\n${info.video_count} vidéos · ${info.uploader}`, info.title),
          metadata: { url, playlistId: info.playlistId, uploader: info.uploader, video_count: info.video_count },
        });
        cortex.scheduleIndex(playlistPage);
      }
      const playlistId = playlistPage.id;

      batchAbortRef.current = false;
      const startedAt = Date.now();
      let okCount = 0, skipCount = 0;

      for (let i = 0; i < total; i++) {
        if (batchAbortRef.current) break;

        const isLotBoundary = i > 0 && i % batchSize === 0;
        if (isLotBoundary) {
          if (batchAbortRef.current) break;
          setBatchProgress(prev => prev ? { ...prev, currentLabel: 'Indexation du lot précédent…' } : null);
          await cortex.flushIndex();
          await new Promise(r => setTimeout(r, batchDelay));
          if (batchAbortRef.current) break;
        }

        const v        = videos[i];
        const lotIndex = Math.floor(i / batchSize) + 1;

        setBatchProgress({
          operation: 'Import de playlist',
          current: i, total, lotIndex, lotTotal,
          currentLabel: v.title,
          okCount, fallbackCount: 0, errorCount: skipCount,
          startedAt,
        });

        const existing = pages.find(p =>
          p.metadata?.url === v.url ||
          (p.kind === 'video' && normalizeTitle(p.title) === normalizeTitle(v.title)),
        );
        let videoId: string;
        if (existing) {
          videoId = existing.id;
          skipCount++;
        } else {
          const vPage = await createPageFromData({
            title:    v.title,
            kind:     'video',
            blocks:   createContentBlocks(v.url, v.title),
            metadata: { url: v.url, light: true, youtubeId: v.id, playlistId: info.playlistId },
          });
          cortex.scheduleIndex(vPage);
          videoId = vPage.id;
          okCount++;
        }

        const currentPlaylistPage = pages.find(p => p.id === playlistId);
        if (!(currentPlaylistPage?.links ?? []).includes(videoId)) {
          createLink(playlistId, videoId);
        }

        setBatchProgress(prev => prev ? { ...prev, current: i + 1, okCount, errorCount: skipCount } : null);
      }

      await cortex.flushIndex();
      setBatchProgress(null);
      runNextInQueue();

      // Explicitly save the playlist page with all accumulated links from React state.
      // createLink fires saves eagerly but each save only sees one link (stale lastRenderedState).
      // A short delay lets React re-render with all queued createLink updates so
      // pagesRef.current has the complete links list before we persist it.
      await new Promise(r => setTimeout(r, 120));
      const finalPlaylistPage = pagesRef.current.find(p => p.id === playlistId);
      if (finalPlaylistPage) savePage(finalPlaylistPage).catch(() => {});

      const aborted = batchAbortRef.current;
      setToast(aborted
        ? `Import annulé — ${okCount} vidéos créées, ${skipCount} déjà existantes`
        : `Playlist importée : ${okCount} nouvelles vidéos${skipCount > 0 ? `, ${skipCount} déjà existantes` : ''}`,
      );
    };

    enqueueOrStart(`Import playlist (${total} vidéos)`, total, runBatch);
  }, [playlistImport, pages, batchSize, batchDelay, createPageFromData, cortex, createLink]);

  const handleRequestDelete = useCallback((id: string) => {
    setPendingDeleteId(id);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteId) return;
    const page = pages.find(p => p.id === pendingDeleteId);
    // Delete any image files referenced by this page's blocks
    if (page) {
      for (const block of page.blocks) {
        if (block.type === 'image' && block.content) {
          void cortexClient.deleteImage(block.content);
        }
      }
    }
    await removePage(pendingDeleteId);
    cortex.scheduleDelete(pendingDeleteId);
    if (selectedId === pendingDeleteId) setSelectedId(null);
    setPendingDeleteId(null);
    setToast(`Neurone "${page?.title || 'Sans titre'}" supprimé`);
  }, [pendingDeleteId, pages, removePage, cortex, selectedId]);

  const handleCreateLink = useCallback((targetId: string) => {
    if (!linkPickerForId) return;
    createLink(linkPickerForId, targetId);
    const src = pages.find(p => p.id === linkPickerForId);
    const tgt = pages.find(p => p.id === targetId);
    setToast(`Synapse : ${src?.title || '?'} ↔ ${tgt?.title || '?'}`);
  }, [linkPickerForId, createLink, pages]);

  const handleRemoveLink = useCallback((targetId: string) => {
    if (!selectedId) return;
    removeLink(selectedId, targetId);
  }, [selectedId, removeLink]);

  // ── Reindex ───────────────────────────────────────────────────────────────

  const handleConfirmReindex = useCallback(async () => {
    setReindexRunning(true);
    setReindexProgress(0);
    // Ensure all pages have full blocks before reindex (lazy stubs have blocks: [])
    const allFull = await loadAllPagesForReindex();
    const count = await cortex.triggerReindexAll(allFull, (n) => setReindexProgress(n));
    setReindexRunning(false);
    setShowReindex(false);
    setToast(`${count} neurone${count > 1 ? 's' : ''} ré-indexé${count > 1 ? 's' : ''}`);
  }, [cortex, loadAllPagesForReindex]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  const anyModalOpen = useAnyModalOpen();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {

      // Escape → close editor panel (only when no modal/overlay is open)
      if (e.key === 'Escape' && !anyModalOpen && selectedId) {
        setSelectedId(null);
        return;
      }

      // Ctrl+, → open settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',' && !anyModalOpen) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      // Ctrl+N → open quick capture (blocked if another modal is open)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !anyModalOpen) {
        e.preventDefault();
        setCaptureOpen(true);
        return;
      }
      // F1 / Ctrl+H → open help panel
      if (e.key === 'F1' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h')) {
        e.preventDefault();
        if (!anyModalOpen) setHelpOpen(true);
        return;
      }
      // Alt+A → lecture / pause du lecteur audio
      if (e.altKey && e.key.toLowerCase() === 'a' && !anyModalOpen) {
        e.preventDefault();
        audioPlayerToggleRef.current?.();
        return;
      }
      // Ctrl+L → open search console (no Shift, no modal already open)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setConsoleOpen(v => !v);
        return;
      }
      // Ctrl+Shift+L → link picker for current page
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        if (selectedId) { e.preventDefault(); setLinkPickerForId(selectedId); }
        return;
      }
      // Del / Backspace → confirm delete (only when not in console and not editing text)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !consoleOpen) {
        const active = document.activeElement;
        const editing =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable);
        if (!editing) { e.preventDefault(); setPendingDeleteId(selectedId); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, consoleOpen, pendingDeleteId, anyModalOpen]);

  useEffect(() => {
    function onCorpus3DChanged() { setCorpusShow3D(getCorpusShowIn3D()); }
    window.addEventListener('docteur-corpus-3d-changed', onCorpus3DChanged);
    return () => window.removeEventListener('docteur-corpus-3d-changed', onCorpus3DChanged);
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────

  const pendingDeletePage = pendingDeleteId ? pages.find(p => p.id === pendingDeleteId) : null;
  const cortexBusy        = cortex.indexing.size > 0 || cortex.queueSize > 0;

  // Load voice settings once cortex is available
  useEffect(() => {
    if (!cortex.available) return;
    cortexClient.getVoiceSettings().then(setVoiceSettings).catch(() => {});
  }, [cortex.available]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={`docteur-shell${isMobile && showMobileBrain ? ' mobile-brain-visible' : ''}`}>
      {(!isMobile || showMobileBrain) && (
        <NeuralBrain
          pages={corpusShow3D ? pages : pages.filter(p => p.kind !== 'corpus')}
          selectedPageId={selectedId}
          compact={isMobile}
          className="brain-stage"
          onNodeSelect={setSelectedId}
          indexingIds={cortex.indexing}
          highlightedIds={sourceHighlights}
          gestureInputRef={gestureInputRef}
        />
      )}

      <div className="shell-topbar">
        <TopBar
          pageCount={pageCounts.total || pages.length}
          cortexAvailable={cortex.available}
          cortexBusy={cortexBusy}
          cortexQueueSize={cortex.queueSize}
          cortexIndexCount={cortex.indexing.size}
          isOnline={isOnline}
          onSearchOpen={() => setConsoleOpen(true)}
          onCaptureOpen={() => setCaptureOpen(true)}
          onBackupOpen={() => setBackupOpen(true)}
          onCorpusOpen={() => setCorpusOpen(true)}
          onActivityLogOpen={() => setActivityLogOpen(true)}
          onSettingsOpen={() => setSettingsOpen(true)}
          onHelpOpen={() => setHelpOpen(true)}
          onRoadmapOpen={() => setRoadmapOpen(true)}
          onAgentsOpen={() => setAgentsOpen(true)}
          onVideoSummaryOpen={() => {
            setVideoSummaryOpen(true);
            setVideoSummaryMinimized(false);
            void cortexClient.routerSettings().then(s => setStrictLocalMode(!!s.strict_local_mode)).catch(() => {});
          }}
          onSkillsOpen={() => setSkillsOpen(true)}
          onPromptGeneratorOpen={() => setPromptGeneratorOpen(true)}
          onKiwixOpen={() => setKiwixOpen(true)}
          onTeacherOpen={() => setTeacherOpen(true)}
          onNotebookOpen={() => setNotebookOpen(true)}
          onImageGeneratorOpen={() => setImageGeneratorOpen(true)}
          onTodoOpen={() => setTodoOpen(true)}
          todoPendingCount={todoPendingCount}
          voiceEnabled={voiceSettings?.enabled ?? false}
          voiceState={voice.state}
          onVoiceClick={voice.triggerManual}
          gestureState={gesture.gestureState}
          onCameraClick={gesture.toggle}
          screenShareState={screenShare.state}
          onScreenShareClick={screenShare.toggle}
          activeBatch={batchMinimized ? batchProgress : null}
          batchQueueLength={batchMinimized ? batchQueue.length : 0}
          onBatchClick={() => setBatchMinimized(false)}
        />
      </div>

      {/* Sidebar : hidden on mobile when editor is open */}
      <div className={`shell-sidebar${isMobile && selectedId ? ' mobile-hidden' : ''}`}>
        <Sidebar
          pages={pages}
          selectedPageId={selectedId}
          loading={loading}
          cortexAvailable={cortex.available}
          onSelectPage={setSelectedId}
          onNewPage={handleNewPage}
          onDeletePage={handleRequestDelete}
          onRequestReindex={() => { setReindexProgress(0); setShowReindex(true); }}
          showHomeScreen={showHomeScreen}
          onToggleHomeScreen={setShowHomeScreen}
          onCaptureOpen={() => setCaptureOpen(true)}
          onSearchOpen={() => setConsoleOpen(true)}
          pageCounts={pageCounts}
          allMetaLoaded={allMetaLoaded}
          onLoadAllPages={loadAllMeta}
        />
      </div>

      {selectedPage && (
        <div 
          className="shell-editor" 
          style={{ 
            position: 'fixed',
            zIndex: 50,
          }}
        >
          {pageContentLoading && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(10,8,20,0.6)', backdropFilter: 'blur(4px)',
            }}>
              <div className="neural-dot" />
            </div>
          )}
          <PageEditor
            key={selectedPage.id}
            page={selectedPage}
            allPages={pages}
            onUpdate={handleUpdatePage}
            onDelete={() => setPendingDeleteId(selectedPage.id)}
            onOpenLinkPicker={() => setLinkPickerForId(selectedPage.id)}
            onRemoveLink={handleRemoveLink}
            onNavigateTo={setSelectedId}
            onClose={() => {
              if (localStorage.getItem('docteur-gesture-debug') === 'true') console.debug('[editor] CLOSE_CLICK', { neuronId: selectedPage.id });
              setSelectedId(null);
            }}
            onExportPdf={() => setPdfExportPage({ pageId: selectedPage.id, title: selectedPage.title })}
            onReviewPage={() => handleReviewPage(selectedPage)}
            reviewLoading={reviewingId === selectedPage.id}
            onRegenerateVeille={(level) => handleRegenerateVeille(selectedPage, level)}
            regenerateLoading={regeneratingId === selectedPage.id}
            onDeepAnalyze={deepAnalyzeNeurons}
            onResummarise={(selectedPage.metadata?.deep_capture === true || selectedPage.metadata?.deep_analyzed === true) && selectedPage.kind === 'video' ? () => setResummariseId(selectedPage.id) : undefined}
            onPlayVideo={(videoId, title) => { setActiveVideo({ videoId, title }); }}
            maxVideoSelect={groqActive ? 30 : 10}
            transferImages={transferImages}
            onCvAnalyze={selectedPage.kind === 'cv' ? (powerful) => handleCvAnalyze(selectedPage, powerful) : undefined}
            onCvRewrite={selectedPage.kind === 'cv' ? () => setCvRewriteModalReq({ sourcePageId: selectedPage.id }) : undefined}
            onCvLetter={selectedPage.kind === 'cv' ? () => setCandidatureLetterReq({ cvPageId: selectedPage.id }) : undefined}
            onCvImportPdf={selectedPage.kind === 'cv' ? () => setCvPdfImportOpen(true) : undefined}
            onCvTargetJobs={selectedPage.kind === 'cv' ? () => handleCvTargetJobs(selectedPage) : undefined}
            onCvAtsKeywords={selectedPage.kind === 'cv' ? () => handleCvAtsKeywords(selectedPage) : undefined}
            onCvMasterCv={selectedPage.kind === 'cv' ? () => handleCvMasterCv(selectedPage) : undefined}
            onCvAdaptCv={selectedPage.kind === 'cv' ? () => setCvAdaptModalReq({ sourcePageId: selectedPage.id }) : undefined}
            onCvFreeQuestion={selectedPage.kind === 'cv' ? () => setCvFreeQuestionModalReq({ sourcePageId: selectedPage.id }) : undefined}
            cvBusy={cvBusyId === selectedPage.id}
            onTogglePrivate={() => handleUpdatePage(selectedPage.id, { private: !selectedPage.private })}
            onDuplicatePrompt={selectedPage.kind === 'prompt' ? async () => {
              const dup = await createPageFromData({
                title:    `${selectedPage.title} (copie)`,
                kind:     'prompt',
                blocks:   selectedPage.blocks.map(b => ({ ...b, id: generateId() })),
                metadata: { ...(selectedPage.metadata ?? {}), template: false, derived_from: selectedPage.id },
              });
              createLink(selectedPage.id, dup.id);
              setSelectedId(dup.id);
            } : undefined}
            onTranscribePlaylist={
              (selectedPage.kind === 'playlist' || selectedPage.kind === 'channel')
              ? async (ids) => {
                if (selectedPage.kind === 'channel') {
                  // Channel: show estimation modal first (may be hundreds of videos)
                  setChannelLimitInput('');
                  setChannelTranscribeRequest({ videoIds: ids });
                  return;
                }
                // Playlist: 100-video limit with confirm
                const limited = ids.slice(0, 100);
                if (ids.length > 100 && !window.confirm(`${ids.length} vidéos non transcrites. Seules les 100 premières seront traitées. Continuer ?`)) return;
                try { setWhisperBatchStats(await cortexClient.getWhisperStats()); } catch { setWhisperBatchStats(null); }
                setWhisperBatchChoice({ ids: limited, fromPlaylist: true });
              }
              : undefined
            }
            onAnalyzeImage={setVisionImageId}
          />
        </div>
      )}

      {/* Selected neuron not found in memory after an on-demand fetch attempt —
          e.g. it was deleted, or the fetch failed. Never leave the click silent. */}
      {selectedId && !selectedPage && (
        <div
          className="flex items-center justify-center"
          style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(10,8,20,0.85)', pointerEvents: pageContentLoading ? 'none' : 'auto' }}
          onClick={() => { if (!pageContentLoading) setSelectedId(null); }}
        >
          <div
            className="font-mono text-sm flex flex-col items-center gap-3"
            style={{ color: pageContentLoading ? '#7a6c9a' : '#ff8b3d' }}
            onClick={e => e.stopPropagation()}
          >
            {pageContentLoading ? (
              <>Chargement du neurone…</>
            ) : (
              <>
                <span>Neurone introuvable — il a peut-être été supprimé.</span>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="rounded px-3 py-1.5"
                  style={{ border: '1px solid rgba(255,139,61,0.3)', background: 'rgba(255,139,61,0.08)', color: '#ff8b3d', cursor: 'pointer' }}
                >
                  Fermer
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {pendingDeletePage && (
        <ConfirmDeleteModal
          page={pendingDeletePage}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {compareQuestion && (
        <CompareModal
          question={compareQuestion}
          onClose={() => setCompareQuestion(null)}
          onSaveResponse={handleCompareSaveResponse}
          onSaveComparison={handleCompareSaveComparison}
        />
      )}

      {resummariseId && (() => {
        const rPage = pages.find(p => p.id === resummariseId);
        if (!rPage) return null;
        const rUrl = typeof rPage.metadata?.url === 'string' ? rPage.metadata.url : '';
        return (
          <ResummariseModal
            page={rPage}
            onClose={() => setResummariseId(null)}
            onDone={(summary, model) => handleResummariseDone(resummariseId, summary, model)}
            onRetranscribe={rUrl ? () => {
              setResummariseId(null);
              setWhisperRequest({ url: rUrl, title: rPage.title, duration: null, groqAvailable: groqActive });
            } : undefined}
          />
        );
      })()}

      {cvPdfImportOpen && (
        <CvPdfImportModal
          onImport={handleCvPdfImport}
          onClose={() => setCvPdfImportOpen(false)}
        />
      )}

      {cvRewriteModalReq && (() => {
        const srcPage = pages.find(p => p.id === cvRewriteModalReq.sourcePageId);
        return srcPage ? (
          <CvRewriteModal
            sourcePage={srcPage}
            onRewrite={async (opts) => { await handleCvRewrite(srcPage, opts); }}
            onClose={() => setCvRewriteModalReq(null)}
          />
        ) : null;
      })()}

      {cvAdaptModalReq && (() => {
        const srcPage = pages.find(p => p.id === cvAdaptModalReq.sourcePageId);
        return srcPage ? (
          <CvAdaptModal
            sourcePage={srcPage}
            onAdapt={async (opts) => { await handleCvAdaptCv(srcPage, opts.jobOffer, opts.powerful); }}
            onClose={() => setCvAdaptModalReq(null)}
          />
        ) : null;
      })()}

      {cvFreeQuestionModalReq && (() => {
        const srcPage = pages.find(p => p.id === cvFreeQuestionModalReq.sourcePageId);
        return srcPage ? (
          <CvFreeQuestionModal
            cvTitle={srcPage.title}
            onAsk={(params) => handleCvFreeQuestionAsk(srcPage, params)}
            onSaveResult={(params) => handleCvFreeQuestionSave(srcPage, params)}
            onClose={() => setCvFreeQuestionModalReq(null)}
          />
        ) : null;
      })()}

      {candidatureLetterReq && (
        <CandidatureLetterModal
          cvPages={pages.filter(p => p.kind === 'cv')}
          initialCvId={candidatureLetterReq.cvPageId}
          prefillContext={candidatureLetterReq.prefillContext}
          onGenerate={handleCvLetter}
          onClose={() => setCandidatureLetterReq(null)}
        />
      )}

      {linkPickerForId && (
        <LinkPickerModal
          currentPageId={linkPickerForId}
          pages={pages}
          onSelect={handleCreateLink}
          onClose={() => setLinkPickerForId(null)}
        />
      )}

      {showReindex && (
        <ReindexModal
          total={pages.length}
          progress={reindexProgress}
          running={reindexRunning}
          onConfirm={handleConfirmReindex}
          onClose={() => { if (!reindexRunning) setShowReindex(false); }}
        />
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      <UpdateBanner flushSaves={flushAllSaves} />

      {pdfExportPage && (
        <PdfExportModal
          variant="neuron"
          pageId={pdfExportPage.pageId}
          title={pdfExportPage.title}
          onClose={() => setPdfExportPage(null)}
          onToast={msg => setToast(msg)}
        />
      )}

      {pdfSubjectInitial !== '' && (
        <PdfExportModal
          variant="subject"
          initialSubject={pdfSubjectInitial}
          onClose={() => setPdfSubjectInitial('')}
          onToast={msg => setToast(msg)}
        />
      )}

      {backupOpen && <BackupModal pages={pages} onClose={() => setBackupOpen(false)} onRestorePages={handleRestorePages} />}

      {corpusOpen && <CorpusModal onClose={() => setCorpusOpen(false)} onReload={reloadFromServer} />}

      {activityLogOpen && <ActivityLogModal onClose={() => setActivityLogOpen(false)} />}

      {helpOpen && (
        <HelpModal
          onClose={() => setHelpOpen(false)}
          onOpenFeature={(feature) => {
            setHelpOpen(false);
            switch (feature) {
              case 'capture':         setCaptureOpen(true); break;
              case 'console':         setConsoleOpen(true); break;
              case 'notebook':        setNotebookOpen(true); break;
              case 'teacher':         setTeacherOpen(true); break;
              case 'agents':          setAgentsOpen(true); break;
              case 'skills':          setSkillsOpen(true); break;
              case 'images':          setImageGeneratorOpen(true); break;
              case 'metagpt':         setMetaGptStudioOpen(true); break;
              case 'kiwix':           setKiwixOpen(true); break;
              case 'todo':            setTodoOpen(true); break;
              case 'backup':          setBackupOpen(true); break;
              case 'corpus':          setCorpusOpen(true); break;
              case 'prompt-generator':setPromptGeneratorOpen(true); break;
              case 'video-summary':   setVideoSummaryOpen(true); break;
              case 'settings-models':   setSettingsInitialTab('models'); setSettingsOpen(true); break;
              case 'settings-memory':   setSettingsInitialTab('memory'); setSettingsOpen(true); break;
              case 'settings-images':   setSettingsInitialTab('images'); setSettingsOpen(true); break;
              case 'settings-privacy':  setSettingsInitialTab('privacy'); setSettingsOpen(true); break;
              case 'settings-audio':    setSettingsInitialTab('audio'); setSettingsOpen(true); break;
              case 'settings-files':    setSettingsInitialTab('files'); setSettingsOpen(true); break;
              case 'settings-vocal':    setSettingsInitialTab('vocal'); setSettingsOpen(true); break;
              case 'settings-external': setSettingsInitialTab('external'); setSettingsOpen(true); break;
              case 'settings-connections': setSettingsInitialTab('connections'); setSettingsOpen(true); break;
              case 'settings': default: setSettingsOpen(true); break;
            }
          }}
        />
      )}

      <RoadmapModal isOpen={roadmapOpen} onClose={() => setRoadmapOpen(false)} />

      {agentsOpen && (
        <AgentsModal
          onClose={() => setAgentsOpen(false)}
          onAgentOutput={async (output) => {
            await handleAgentOutput(output);
            setAgentsOpen(false);
          }}
        />
      )}

      {videoSummaryOpen && !videoSummaryMinimized && (
        <VideoSummaryModal
          onClose={() => setVideoSummaryOpen(false)}
          onMinimize={() => setVideoSummaryMinimized(true)}
          strictLocalMode={strictLocalMode}
          onDone={() => { void reloadFromServer(); }}
        />
      )}

      {todoOpen && (
        <TodoPanel
          onClose={() => { setTodoOpen(false); void cortexClient.getTodos().then(items => setTodoPendingCount(items.filter(i => i.status === 'pending').length)); }}
          onCaptureNow={(item: TodoItem) => {
            setTodoOpen(false);
            if (item.url) {
              void captureFromInput(item.url).then(async () => {
                // Mark done — the capture system will handle creating the neuron
                // We update optimistically; if capture failed it stays visible on next open
                await cortexClient.updateTodo(item.id, { status: 'done', done_at: new Date().toISOString() });
                const items = await cortexClient.getTodos();
                setTodoPendingCount(items.filter(i => i.status === 'pending').length);
              }).catch(async (err: Error) => {
                await cortexClient.updateTodo(item.id, { status: 'failed', error: err.message });
              });
            }
          }}
          onSelectNeuron={(id: string) => {
            const p = pages.find(x => x.id === id);
            if (p) { setSelectedId(id); setTodoOpen(false); }
          }}
        />
      )}

      <SkillsModal
        isOpen={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        onCreateNeuron={async (title, content, kind) => {
          const page = await createPageFromData({
            title,
            kind: (kind as import('./lib/types').PageKind) ?? 'note',
            blocks: createContentBlocks(content, title),
          });
          cortex.scheduleIndex(page);
        }}
      />

      {promptGeneratorOpen && (
        <PromptGeneratorModal
          onClose={() => setPromptGeneratorOpen(false)}
          strictLocalMode={strictLocalMode}
        />
      )}

      {teacherOpen && (
        <TeacherModal
          onClose={() => setTeacherOpen(false)}
          strictLocalMode={strictLocalMode}
        />
      )}

      {notebookOpen && (
        <Suspense fallback={<LazyModalFallback />}>
          <NotebookModal onClose={() => setNotebookOpen(false)} />
        </Suspense>
      )}

      {imageGeneratorOpen && (
        <Suspense fallback={<LazyModalFallback />}>
          <ImageGeneratorModal
            onClose={() => setImageGeneratorOpen(false)}
            strictLocalMode={strictLocalMode}
            onOpenSettings={() => { setImageGeneratorOpen(false); setSettingsOpen(true); }}
          />
        </Suspense>
      )}
      {metaGptStudioOpen && <Suspense fallback={null}><MetaGptStudioModal onClose={() => setMetaGptStudioOpen(false)} /></Suspense>}

      {kiwixOpen && (
        <KiwixLibraryModal onClose={() => setKiwixOpen(false)} />
      )}

      <AudioPlayer registerToggle={(fn) => { audioPlayerToggleRef.current = fn; }} />

      {/* ── Playlist choice (video with &list= param) ──────────────────────── */}
      {playlistChoice && (
        <div className="modal-backdrop" onClick={() => setPlaylistChoice(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 'min(400px, calc(100vw - 24px))', border: '1px solid rgba(232,121,249,0.25)', borderRadius: 12, padding: 0, overflow: 'hidden' }}>
            <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(232,121,249,0.1)' }}>
              <ListVideo size={16} style={{ color: '#e879f9', flexShrink: 0 }} />
              <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>Ce lien fait partie d'une playlist</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-2">
              <button type="button" className="modal-btn-cancel font-mono text-sm w-full py-2.5" onClick={() => { setPlaylistChoice(null); void captureFromInput(playlistChoice.videoUrl); }}>
                Juste cette vidéo
              </button>
              <button
                type="button"
                className="font-mono text-sm w-full py-2.5 rounded flex items-center justify-center gap-2"
                style={{ background: 'rgba(232,121,249,0.1)', border: '1px solid rgba(232,121,249,0.3)', color: '#e879f9', cursor: 'pointer' }}
                onClick={() => { const url = playlistChoice.playlistUrl; setPlaylistChoice(null); setPlaylistImport({ url, info: null, loading: true }); }}
              >
                <ListVideo size={13} />
                Toute la playlist
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Playlist import modal (loading → confirm only; progress → BatchProgressModal) ── */}
      {playlistImport && (
        <div className="modal-backdrop">
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 'min(440px, calc(100vw - 24px))', border: '1px solid rgba(232,121,249,0.25)', borderRadius: 12, padding: 0, overflow: 'hidden' }}>
            <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(232,121,249,0.1)' }}>
              <ListVideo size={16} style={{ color: '#e879f9', flexShrink: 0 }} />
              <div className="flex-1">
                <p className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>Import de playlist</p>
                <p className="font-mono truncate" style={{ fontSize: 10, color: '#7a6c9a', marginTop: 2 }}>{playlistImport.url}</p>
              </div>
            </div>
            <div className="px-5 py-4">
              {playlistImport.loading && (
                <p className="font-mono text-xs" style={{ color: '#7a6c9a' }}>Récupération des infos de la playlist…</p>
              )}
              {!playlistImport.loading && playlistImport.info && (
                <>
                  <p className="font-mono text-sm mb-1" style={{ color: '#f0eaff' }}>{playlistImport.info.title}</p>
                  <p className="font-mono text-xs mb-4" style={{ color: '#7a6c9a' }}>{playlistImport.info.uploader} · {playlistImport.info.video_count} vidéos</p>
                  {playlistImport.info.video_count > 30 && (
                    <p className="font-mono text-xs mb-3 px-3 py-2 rounded" style={{ background: 'rgba(255,139,61,0.06)', border: '1px solid rgba(255,139,61,0.18)', color: '#ff8b3d' }}>
                      Traitement par lots de {batchSize} ({Math.ceil(playlistImport.info.video_count / batchSize)} lots).
                      Annulable à tout moment.
                    </p>
                  )}
                  <div className="flex gap-2 justify-end">
                    <button type="button" className="modal-btn-cancel font-mono text-sm" onClick={() => setPlaylistImport(null)}>Annuler</button>
                    <button type="button" className="font-mono text-sm px-4 py-2 rounded flex items-center gap-2" style={{ background: 'rgba(232,121,249,0.1)', border: '1px solid rgba(232,121,249,0.3)', color: '#e879f9', cursor: 'pointer' }} onClick={handlePlaylistConfirm}>
                      <ListVideo size={13} />
                      Importer {playlistImport.info.video_count} vidéos
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Batch progress (deep capture + playlist processing) ───────────────── */}
      {batchProgress && !batchMinimized && (
        <BatchProgressModal
          state={batchProgress}
          color={batchProgress.operation === 'Import de playlist' ? '#e879f9' : '#5ee7ff'}
          onCancel={() => { batchAbortRef.current = true; }}
          onMinimize={() => setBatchMinimized(true)}
          queue={batchQueue}
          onRemoveQueued={id => {
            setBatchQueue(q => q.filter(j => j.id !== id));
            batchQueueRef.current = batchQueueRef.current.filter(j => j.id !== id);
          }}
          onCancelAll={() => {
            batchAbortRef.current = true;
            setBatchQueue([]);
            batchQueueRef.current = [];
            queueSessionRef.current = { totalJobs: 0 };
          }}
        />
      )}

      {/* ── Batch failure summary (persistent until closed) ─────────────────────── */}
      {batchFailures && (
        <div className="modal-backdrop">
          <div
            className="modal-box"
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(480px, calc(100vw - 24px))', borderRadius: 12, padding: 0, overflow: 'hidden', border: '1px solid rgba(255,77,88,0.3)' }}
          >
            <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(255,77,88,0.12)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff4d58', flexShrink: 0 }} />
              <p className="font-grotesk font-semibold text-sm flex-1" style={{ color: '#f0eaff' }}>
                {batchFailures.length} élément{batchFailures.length > 1 ? 's' : ''} ignoré{batchFailures.length > 1 ? 's' : ''}
              </p>
              <button
                type="button"
                onClick={() => setBatchFailures(null)}
                className="font-mono"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, cursor: 'pointer', color: '#c0b0e0', padding: '3px 10px', fontSize: 11 }}
              >
                Fermer
              </button>
            </div>
            <div className="px-5 py-4">
              <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {batchFailures.map((f, idx) => (
                  <div
                    key={idx}
                    style={{ background: 'rgba(255,77,88,0.04)', border: '1px solid rgba(255,77,88,0.1)', borderRadius: 5, padding: '5px 10px' }}
                  >
                    <p className="font-mono truncate" style={{ fontSize: 11, color: '#f0d0d0' }}>{f.label}</p>
                    <p className="font-mono" style={{ fontSize: 10, color: '#7a4a5a', marginTop: 1 }}>{f.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm large batch ───────────────────────────────────────────────── */}
      {confirmBatch && (
        <ConfirmBatchModal
          count={confirmBatch.count}
          operation={confirmBatch.operation}
          batchSize={batchSize}
          estimatedMinutes={confirmBatch.estimatedMinutes}
          onConfirm={confirmBatch.onConfirm}
          onCancel={() => setConfirmBatch(null)}
        />
      )}

      {/* ── Channel transcription estimation modal ───────────────────────────── */}
      {channelTranscribeRequest && (() => {
        const total = channelTranscribeRequest.videoIds.length;
        const parsedN = parseInt(channelLimitInput);
        const effectiveN = (Number.isInteger(parsedN) && parsedN > 0 && parsedN < total) ? parsedN : total;
        const avgMinPerVideo = 10;
        const estimatedHours = Math.ceil((effectiveN * avgMinPerVideo) / 60 * 10) / 10;
        const confirm50 = effectiveN > 50;
        return (
          <div className="whisper-overlay">
            <div className="whisper-card" style={{ maxWidth: 400 }}>
              <div className="whisper-card__icon">🎙️ Transcription de chaîne</div>
              <div className="whisper-card__body">
                <strong>{total} vidéo{total !== 1 ? 's' : ''}</strong> non transcrites dans cette chaîne.
                <br />
                <span style={{ color: '#f97316' }}>
                  Estimation : ~<strong>{estimatedHours} h</strong> en local
                  <span style={{ fontSize: 9, opacity: 0.75 }}> (base : {avgMinPerVideo} min/vidéo en moyenne)</span>
                </span>
                <br />
                {confirm50 && (
                  <span style={{ color: '#f59e0b', fontSize: 11 }}>
                    ⚠️ {effectiveN} vidéos — traitement de longue durée.
                  </span>
                )}
              </div>

              {/* N premières */}
              <div style={{ padding: '0 24px 12px' }}>
                <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', marginBottom: 6 }}>
                  Limiter à N vidéos (les plus récentes en premier) :
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={total}
                    value={channelLimitInput}
                    onChange={e => setChannelLimitInput(e.target.value)}
                    placeholder={`${total} (toutes)`}
                    className="font-mono"
                    style={{
                      width: 90, padding: '4px 8px', borderRadius: 5, fontSize: 11,
                      background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
                      color: '#e2d9f3', outline: 'none',
                    }}
                  />
                  <span className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>
                    sur {total} · ~{estimatedHours} h
                  </span>
                </div>
              </div>

              <div className="whisper-card__actions" style={{ flexDirection: 'column', gap: 8 }}>
                <button
                  type="button"
                  className="whisper-btn-confirm"
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                  onClick={async () => {
                    const toProcess = channelTranscribeRequest.videoIds.slice(0, effectiveN);
                    setChannelTranscribeRequest(null);
                    setChannelLimitInput('');
                    if (confirm50 && !window.confirm(`${toProcess.length} vidéos à transcrire (~${estimatedHours} h). Lancer le traitement ?`)) return;
                    try { setWhisperBatchStats(await cortexClient.getWhisperStats()); } catch { setWhisperBatchStats(null); }
                    setWhisperBatchChoice({ ids: toProcess, fromPlaylist: true });
                  }}
                >
                  <span>Continuer →</span>
                  <span style={{ fontSize: 9, opacity: 0.85 }}>Choisir le provider au prochain écran</span>
                </button>
                <button
                  type="button"
                  className="whisper-btn-cancel"
                  onClick={() => { setChannelTranscribeRequest(null); setChannelLimitInput(''); }}
                >
                  Annuler
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Whisper batch provider choice modal ─────────────────────────────── */}
      {whisperBatchChoice && (() => {
        const n = whisperBatchChoice.ids.length;
        const localOk = n <= LOCAL_WHISPER_LIMIT;
        const groqOk  = n <= 30;
        // Quota estimate for playlist pre-flight
        const GROQ_DAILY_LIMIT_MIN = 480;
        const usedMin = whisperBatchStats?.today.groq_minutes ?? 0;
        const remainingMin = Math.max(0, GROQ_DAILY_LIMIT_MIN - usedMin);
        const avgVideoMin = 10; // assume ~10 min average video
        const estimatedGroqCount = whisperBatchChoice.fromPlaylist
          ? Math.min(n, Math.floor(remainingMin / avgVideoMin))
          : null;
        const estimatedLocalCount = estimatedGroqCount !== null ? n - estimatedGroqCount : null;
        return (
          <div className="whisper-overlay">
            <div className="whisper-card">
              <div className="whisper-card__icon">🎙️ Transcription Whisper</div>
              <div className="whisper-card__body">
                <strong>{n} vidéo{n !== 1 ? 's' : ''}</strong> à transcrire.
                {whisperBatchChoice.fromPlaylist && groqActive && whisperBatchStats && (
                  <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)', fontSize: 10 }}>
                    <span style={{ color: '#a78bfa' }}>Quota Groq aujourd&apos;hui : </span>
                    <span style={{ color: '#f97316' }}>{usedMin} min utilisées</span>
                    <span style={{ color: '#5a4a7a' }}> / {GROQ_DAILY_LIMIT_MIN} min</span>
                    {remainingMin > 0 ? (
                      <span style={{ color: '#34d399' }}> · ~{remainingMin} min restantes</span>
                    ) : (
                      <span style={{ color: '#ff4d58' }}> · quota épuisé</span>
                    )}
                    {estimatedGroqCount !== null && (
                      <div style={{ marginTop: 3, color: '#9080c0' }}>
                        En mode Auto : ~{estimatedGroqCount} via Groq · {estimatedLocalCount} en local
                      </div>
                    )}
                  </div>
                )}
                <br />Choisir le provider pour tout le lot :
              </div>
              <div className="whisper-card__actions" style={{ flexDirection: 'column', gap: 8 }}>
                {groqActive && (
                  <>
                    <button
                      type="button"
                      className="whisper-btn-confirm"
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', cursor: 'pointer' }}
                      onClick={() => {
                        const { ids } = whisperBatchChoice;
                        setWhisperBatchChoice(null);
                        setWhisperBatchStats(null);
                        enqueueOrStart(`Analyse auto (${ids.length} vidéos)`, ids.length, () => runDeepBatch(ids, 'auto'));
                      }}
                    >
                      <span>🤖 Auto (Groq si dispo)</span>
                      <span style={{ fontSize: 9, opacity: 0.85 }}>Groq en priorité · bascule local si quota épuisé</span>
                    </button>
                    <button
                      type="button"
                      className="whisper-btn-confirm"
                      disabled={!groqOk}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                        background: groqOk ? 'linear-gradient(135deg,#f97316,#ea580c)' : undefined,
                        opacity: groqOk ? 1 : 0.5, cursor: groqOk ? 'pointer' : 'not-allowed',
                      }}
                      onClick={() => {
                        if (!groqOk) return;
                        const { ids } = whisperBatchChoice;
                        setWhisperBatchChoice(null);
                        setWhisperBatchStats(null);
                        enqueueOrStart(`Analyse Groq (${ids.length} vidéos)`, ids.length, () => runDeepBatch(ids, 'groq'));
                      }}
                    >
                      <span>⚡ Whisper Groq</span>
                      <span style={{ fontSize: 9, opacity: 0.85 }}>
                        {groqOk
                          ? `${n} vidéo${n !== 1 ? 's' : ''} via Groq · rapide · max 30`
                          : `⚠️ Maximum 30 — sélectionnez ${n - 30} vidéo${n - 30 !== 1 ? 's' : ''} de moins`}
                      </span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="whisper-btn-confirm"
                  disabled={!localOk}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                    opacity: localOk ? 1 : 0.5, cursor: localOk ? 'pointer' : 'not-allowed',
                  }}
                  onClick={() => {
                    if (!localOk) return;
                    const { ids } = whisperBatchChoice;
                    setWhisperBatchChoice(null);
                    setWhisperBatchStats(null);
                    enqueueOrStart(`Analyse locale (${ids.length} vidéos)`, ids.length, () => runDeepBatch(ids, 'local'));
                  }}
                >
                  <span>🔒 Whisper local</span>
                  <span style={{ fontSize: 9, opacity: 0.85 }}>
                    {localOk
                      ? `${n} vidéo${n !== 1 ? 's' : ''} en local · privé · max 10`
                      : `⚠️ Maximum 10 en local${groqActive ? ' — utilisez Groq ou sélectionnez moins' : ' — sélectionnez moins de vidéos'}`}
                  </span>
                </button>
                <button type="button" className="whisper-btn-cancel" onClick={() => { setWhisperBatchChoice(null); setWhisperBatchStats(null); }}>
                  Annuler
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Whisper confirmation modal ────────────────────────────────────────── */}
      {whisperRequest && (
        <div className="whisper-overlay">
          <div className="whisper-card">
            <div className="whisper-card__icon">🎙️ Pas de sous-titres</div>
            <div className="whisper-card__body">
              Cette vidéo n'a pas de sous-titres disponibles.
              {whisperRequest.duration && (
                <> Durée : <strong>{Math.round(whisperRequest.duration / 60)} min</strong>
                {' '}— transcription estimée à <strong className="whisper-card__eta">~{Math.max(1, Math.round(whisperRequest.duration / 60 / 5))} min</strong>.</>
              )}
              <br />Choisir la méthode de transcription :
            </div>
            <div className="whisper-card__actions" style={{ flexDirection: 'column', gap: 8 }}>
              {whisperRequest.groqAvailable && (
                <button
                  type="button"
                  className="whisper-btn-confirm"
                  style={{ background: 'linear-gradient(135deg,#f97316,#ea580c)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                  onClick={() => void handleWhisperConfirm(whisperRequest.url, 'groq')}
                >
                  <span>⚡ Groq Whisper</span>
                  <span style={{ fontSize: 9, opacity: 0.8 }}>Meilleure qualité · Rapide · L'audio est envoyé à Groq</span>
                </button>
              )}
              <button
                type="button"
                className="whisper-btn-confirm"
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                onClick={() => void handleWhisperConfirm(whisperRequest.url, 'local')}
              >
                <span>🔒 Whisper local</span>
                <span style={{ fontSize: 9, opacity: 0.8 }}>Privé · L'audio reste sur votre PC · Plus lent</span>
              </button>
              <button type="button" className="whisper-btn-cancel" onClick={() => setWhisperRequest(null)}>
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Whisper progress modal ────────────────────────────────────────────── */}
      {whisperProgress && (() => {
        const wp = whisperProgress;
        const providerBadge = wp.provider === 'groq'
          ? <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.4)', color: '#f97316', marginLeft: 6 }}>⚡ GROQ</span>
          : wp.provider === 'local'
          ? <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399', marginLeft: 6 }}>🔒 LOCAL</span>
          : null;
        return (
          <div className="whisper-overlay">
            <div className="whisper-card whisper-card--narrow">
              <div className="whisper-progress__title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span>
                  {wp.step === 'download' && '⬇️ Téléchargement audio…'}
                  {wp.step === 'transcribe' && '🎙️ Transcription Whisper…'}
                  {wp.step === 'analyse' && '🧠 Analyse du contenu…'}
                  {!wp.step && '⏳ Traitement…'}
                </span>
                {wp.step === 'transcribe' && providerBadge}
              </div>
              {wp.groq_fallback && (
                <div style={{ fontSize: 10, color: '#f97316', textAlign: 'center', padding: '2px 8px 4px', opacity: 0.9 }}>
                  {wp.label?.includes('quota') ? '⚠️ Quota Groq — bascule local' : wp.label?.includes('Clé') ? '⚠️ Clé Groq manquante' : '⚠️ Groq → local'}
                </div>
              )}
              <div className="whisper-progress__bar-track">
                <div className="whisper-progress__bar-fill" style={{ width: `${wp.percent ?? 0}%` }} />
              </div>
              <div className="whisper-progress__footer">
                <span>{wp.groq_fallback ? '' : (wp.label ?? '')}</span>
                <span>{wp.percent ?? 0}%</span>
              </div>
              <button
                type="button"
                className="whisper-btn-abort"
                onClick={() => { whisperAbortRef.current?.abort(); setWhisperProgress(null); }}
              >Annuler</button>
            </div>
          </div>
        );
      })()}

      {settingsOpen && (
        <Suspense fallback={<LazyModalFallback />}>
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            setSettingsInitialTab(undefined);
            // Re-check Groq availability in case keys were saved/removed
            cortexClient.getCloudKeys().then(k => setGroqActive(k.groq_active)).catch(() => {});
          }}
          initialTab={settingsInitialTab}
          corpusCount={pageCounts.byKind.corpus ?? 0}
          gestureSensitivity={gestureSensitivity}
          onGestureSensitivityChange={(v) => { setGestureSensitivityState(v); setGestureSensitivity(v); }}
          easterEggEnabled={easterEggEnabled}
          onEasterEggEnabledChange={(v) => { setEasterEggEnabledState(v); setEasterEggEnabled(v); }}
          onMergeDuplicates={mergeDuplicateParents}
          downloadFolder={downloadFolder}
          onDownloadFolderChange={(f) => { setDownloadFolder(f); localStorage.setItem('docteur.downloadFolder', f); }}
          batchSize={batchSize}
          batchDelay={batchDelay}
          onBatchSizeChange={handleBatchSizeChange}
          onBatchDelayChange={handleBatchDelayChange}
          showHomeScreen={showHomeScreen}
          onShowHomeScreenChange={(v) => { setShowHomeScreen(v); localStorage.setItem('docteur.showHomeScreen', String(v)); }}
          captureImages={captureImages}
          onCaptureImagesChange={(v) => { setCaptureImages(v); localStorage.setItem('docteur.captureImages', String(v)); }}
          transferImages={transferImages}
          onTransferImagesChange={(v) => { setTransferImages(v); localStorage.setItem('docteur.transferImages', String(v)); }}
          customShortcuts={customShortcuts}
          onSetShortcut={async (name, url) => {
            const next = await cortexClient.setShortcut(name, url);
            setCustomShortcuts(next);
          }}
          onDeleteShortcut={async (name) => {
            const next = await cortexClient.deleteShortcut(name);
            setCustomShortcuts(next);
          }}
          onRepairDone={reloadFromServer}
          onInboxImport={async (result) => {
            if (result.processed === 0) return;
            try {
              const pending = await cortexClient.getInboxPending();
              let count = 0;
              for (const item of pending) {
                try {
                  await handleAgentOutput({ title: item.title, content: item.content, kind: 'rapport' });
                  cortexClient.consumeInboxPending(item.id).catch(() => {});
                  count++;
                } catch { /* non-fatal */ }
              }
              if (count > 0) setToast(`${count} rapport${count > 1 ? 's' : ''} importé${count > 1 ? 's' : ''} depuis le dossier surveillé.`);
            } catch { /* non-fatal */ }
          }}
        />
        </Suspense>
      )}

      {downloadUrl && (
        <DownloadModal
          url={downloadUrl}
          downloadFolder={downloadFolder}
          onDone={handleDownloadDone}
          onClose={() => setDownloadUrl(null)}
        />
      )}

      {captureOpen && (
        <CaptureModal
          value={captureValue}
          busy={captureBusy}
          capturePhase={capturePhase}
          onChange={setCaptureValue}
          pendingImages={pendingCaptureImgs}
          onRemoveImage={id => void handleRemovePendingImage(id)}
          onSubmit={async () => {
            if (captureBusy) return;
            const hasPending = pendingCaptureImgs.length > 0;
            const current    = captureValue;
            // Nothing to do
            if (!current.trim() && !hasPending) return;
            // Images only (no text) → create a simple note directly
            if (!current.trim() && hasPending) {
              await handleCaptureSubmitWithImages();
              return;
            }
            // Text present (with or without pending images): full command detection
            const imageBlocks: Block[] = hasPending
              ? pendingCaptureImgs.map(img => ({ id: generateId(), type: 'image' as const, content: img.id }))
              : [];
            const isDeep = parseDeepInput(current) !== null;
            // Simple / no-command capture: close modal immediately
            if (!isDeep) { setCaptureOpen(false); setCaptureValue(''); }
            try {
              await captureFromInput(current, imageBlocks);
              // Clean up pending images after successful capture
              if (hasPending) {
                for (const img of pendingCaptureImgs) URL.revokeObjectURL(img.previewUrl);
                setPendingCaptureImgs([]);
              }
            } catch {
              setToast('Capture impossible');
            }
          }}
          onClose={() => {
            if (capturePhase !== null) return; // deep running — block backdrop close
            if (captureBusy) return;
            if (pendingCaptureImgs.length > 0) {
              if (!window.confirm('Abandonner la capture ? Les images en attente seront supprimées.')) return;
              void discardPendingCaptureImages();
            }
            setCaptureOpen(false);
            setCaptureValue('');
          }}
          onCancelDeep={() => {
            deepAbortRef.current?.abort();
            setCapturePhase(null);
            setCaptureBusy(false);
            setCaptureOpen(false);
            setCaptureValue('');
            void discardPendingCaptureImages();
          }}
          onImagePaste={file => void handleCaptureImagePaste(file)}
        />
      )}

      {conflictRequest && (
        <ConflictModal
          existingNeuron={conflictRequest.existingNeuron}
          proposedParent={conflictRequest.proposedParent}
          onChoose={(choice) => resolveConflict(choice)}
        />
      )}

      <SearchConsole
        isOpen={consoleOpen}
        onClose={() => { setConsoleOpen(false); setVoiceConsoleQuery(null); }}
        initialQuery={voiceConsoleQuery}
        onNavigate={(id) => { setSelectedId(id); setConsoleOpen(false); }}
        onPlayVideo={(videoId, title) => { setActiveVideo({ videoId, title }); setConsoleOpen(false); }}
        onCreatePage={() => { handleNewPage(); setConsoleOpen(false); }}
        onHighlightSources={(ids) => setSourceHighlights(new Set(ids))}
        onClearHighlights={() => setSourceHighlights(new Set())}
        onAnalyzeImage={setVisionImageId}
        onOpenConversation={() => { setConsoleOpen(false); setConversationOpen(true); }}
        isOnline={isOnline}
        customShortcuts={customShortcuts}
        pages={pages}
        onSaveQR={async (question, answer, clarificationContext) => {
          const date    = new Date().toLocaleDateString('fr-FR');
          const sources = answer.sources.map(s => s.title).join(' · ');
          const model   = answer.model_used
            ? `${answer.model_used.split(':')[0]}${answer.router_level ? ` L${answer.router_level}` : ''}`
            : 'local';
          let content = '';
          if (clarificationContext && clarificationContext.length > 0) {
            content += '**Contexte fourni :**\n';
            for (const qa of clarificationContext) {
              const mark = qa.isDefault ? ' *(hypothèse IA)*' : '';
              content += `- **${qa.question}** → ${qa.answer}${mark}\n`;
            }
            content += '\n';
          }
          content += `**Réponse :**\n${answer.answer}\n\n---\n**Sources :** ${sources || 'aucune'}\n**Modèle :** ${model}\n**Date :** ${date}`;
          const page = await createPageFromData({
            title:  question,
            kind:   'question',
            blocks: createContentBlocks(content, question),
          });
          cortex.scheduleIndex(page);
        }}
        onCompare={(q) => { setCompareQuestion(q); setConsoleOpen(false); }}
        onSaveWebAnswer={async (question, answer, sources) => {
          const date    = new Date().toLocaleDateString('fr-FR');
          const srcList = sources.map(s => `- [${s.title}](${s.url})`).join('\n');
          const content = `**Réponse :**\n${answer}\n\n---\n**Sources :**\n${srcList || 'aucune'}\n**Date :** ${date}`;
          const page = await createPageFromData({
            title:  question,
            kind:   'recherche',
            blocks: createContentBlocks(content, question),
          });
          cortex.scheduleIndex(page);
        }}
        onCreateWebResultsNeuron={async (subject, results) => {
          const date    = new Date().toLocaleDateString('fr-FR');
          const links   = results.map(r => `- [${r.title}](${r.url}) — ${r.domain}${r.snippet ? `\n  ${r.snippet}` : ''}`).join('\n');
          const content = `## Résultats DuckDuckGo — ${results.length} liens\n\n${links}\n\n---\n**Recherche :** ${subject}  \n**Date :** ${date}`;
          const page = await createPageFromData({
            title:  subject,
            kind:   'recherche',
            blocks: createContentBlocks(content, subject),
          });
          cortex.scheduleIndex(page);
          setToast(`Neurone "${subject}" créé (${results.length} liens)`);
        }}
        onCreateWebDeepNeuron={async (subject, content, sources, cancelled) => {
          const date    = new Date().toLocaleDateString('fr-FR');
          const srcList = sources.filter(s => s.ok).map(s => `- [${s.title}](${s.url}) — ${s.domain}`).join('\n');
          const body    = `${content}\n\n---\n**Sources lues :**\n${srcList || 'aucune'}\n**Date :** ${date}${cancelled ? '\n> ⚠ Synthèse partielle (recherche annulée)' : ''}`;
          const page = await createPageFromData({
            title:  subject,
            kind:   'recherche',
            blocks: createContentBlocks(body, subject),
          });
          cortex.scheduleIndex(page);
          setToast(`Neurone "${subject}" créé${cancelled ? ' (partiel)' : ''}`);
        }}
        onPdfSubject={(subject) => { setPdfSubjectInitial(subject); }}
        onDeepResearch={async (subject: string, options: DeepResearchOptions) => {
          const date = new Date().toLocaleDateString('fr-FR');
          deepResearchCancelRef.current = false;
          const detailLevel: DetailLevel = options.detailLevel ?? 'synthese';
          void cortexClient.setVeilleSettings(detailLevel).catch(() => null);

          if (options.format === 'document') {
            setToast('Veille approfondie en cours…');
            setDeepResearchProgress({ current: 1, total: 1, topic: 'Génération du document…' });
            try {
              const result = await cortexClient.deepResearchDocument(subject, options.depth, options.source, detailLevel);
              let content = result.content ?? '';
              if (result.sources.length > 0) {
                content += '\n\n---\n**Sources :**\n' + result.sources.map(s => `- [${s.title}](${s.url})`).join('\n');
              }
              const page = await createPageFromData({
                title:  `Veille approfondie : ${subject} — ${date}`,
                kind:   'recherche',
                blocks: createContentBlocks(content, subject),
                metadata: { subject, detailLevel, sources: result.sources ?? [] },
              });
              cortex.scheduleIndex(page);
              setSelectedId(page.id);
              setToast('Document de veille créé');
            } catch (e) {
              setToast(`Veille échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
            } finally {
              setDeepResearchProgress(null);
            }
            return;
          }

          // ── Mode arborescence ──────────────────────────────────────────────
          try {
            setToast('Décomposition du sujet…');
            setDeepResearchProgress({ current: 0, total: options.depth, topic: 'Analyse du sujet…' });

            const { subtopics } = await cortexClient.deepResearchPlan(subject, options.depth);

            if (deepResearchCancelRef.current) {
              setDeepResearchProgress(null);
              setToast('Veille annulée');
              return;
            }

            // Neurone parent
            const parentContent = `# ${subject}\n\nCette veille approfondie couvre ${subtopics.length} sous-sujets complémentaires :\n\n${subtopics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n---\n*Veille approfondie générée par IA le ${date} — à vérifier via les sources.*`;
            const parentPage = await createPageFromData({
              title:  `Veille : ${subject} — ${date}`,
              kind:   'recherche',
              blocks: createContentBlocks(parentContent, subject),
              metadata: { subject, detailLevel },
            });
            cortex.scheduleIndex(parentPage);
            setSelectedId(parentPage.id);

            let createdCount = 0;
            for (let i = 0; i < subtopics.length; i++) {
              if (deepResearchCancelRef.current) break;
              const topic       = subtopics[i];
              const otherTopics = subtopics.filter((_, j) => j !== i);
              setDeepResearchProgress({ current: i + 1, total: subtopics.length, topic });
              setToast(`Sous-sujet ${i + 1}/${subtopics.length} : ${topic}`);
              try {
                const result = await cortexClient.deepResearchSection(subject, topic, i + 1, subtopics.length, options.source, otherTopics, detailLevel);
                let content = result.content ?? '';
                if (result.sources.length > 0) {
                  content += '\n\n---\n**Sources :**\n' + result.sources.map(s => `- [${s.title}](${s.url})`).join('\n');
                }
                const childPage = await createPageFromData({
                  title:  topic,
                  kind:   'recherche',
                  blocks: createContentBlocks(content, topic),
                  metadata: { subject: topic, detailLevel, sources: result.sources ?? [] },
                });
                cortex.scheduleIndex(childPage);
                createLink(parentPage.id, childPage.id);
                createdCount++;
              } catch (e) {
                const err = e as Error & { quota?: boolean };
                if (err.quota) {
                  setDeepResearchProgress(null);
                  setToast(`Quota épuisé — ${createdCount} sous-sujet(s) créé(s) sur ${subtopics.length}. Neurones conservés.`);
                  return;
                }
                // Erreur non fatale : on continue avec le prochain sous-sujet
              }
            }

            const cancelled = deepResearchCancelRef.current;
            setDeepResearchProgress(null);
            if (cancelled) {
              setToast(`Veille annulée — ${createdCount} neurone(s) conservé(s)`);
            } else {
              setToast(`Veille approfondie créée : ${createdCount} neurones reliés`);
            }
          } catch (e) {
            setDeepResearchProgress(null);
            setToast(`Veille échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
          }
        }}
        onMultiSourceResearch={async (subject: string, anglesCount: number, detailLevel: DetailLevel = 'synthese') => {
          const date = new Date().toLocaleDateString('fr-FR');
          deepResearchCancelRef.current = false;
          void cortexClient.setVeilleSettings(detailLevel).catch(() => null);
          setDeepResearchProgress({ current: 0, total: anglesCount + 2, topic: 'Décomposition en angles…' });

          try {
            // Step 1: plan — decompose into angles (1 cascade call)
            const { angles } = await cortexClient.multiResearchPlan(subject, anglesCount);
            if (deepResearchCancelRef.current) { setDeepResearchProgress(null); setToast('Veille annulée'); return; }

            // Step 2: research each angle with grounding
            const sourceResults: Array<{ angle: string; content: string; sources: Array<{ title: string; url: string }> }> = [];
            let groundingFailed = 0;
            for (let i = 0; i < angles.length; i++) {
              if (deepResearchCancelRef.current) break;
              const angle = angles[i];
              setDeepResearchProgress({ current: i + 1, total: angles.length + 2, topic: `Angle ${i + 1}/${angles.length} : ${angle}` });
              setToast(`Veille multi-sources · Angle ${i + 1}/${angles.length}…`);
              try {
                const r = await cortexClient.multiResearchSource(subject, angle, detailLevel);
                sourceResults.push({ angle, content: r.content, sources: r.sources ?? [] });
              } catch (e) {
                const err = e as Error & { quota?: boolean };
                if (err.quota) {
                  setDeepResearchProgress(null);
                  setToast(`Quota épuisé après ${sourceResults.length} angle(s) — recoupement sur les résultats disponibles…`);
                  if (sourceResults.length < 2) { setToast('Quota insuffisant pour continuer (moins de 2 angles collectés).'); return; }
                  break;
                }
                groundingFailed++;
              }
            }

            if (deepResearchCancelRef.current || sourceResults.length < 2) {
              setDeepResearchProgress(null);
              setToast(deepResearchCancelRef.current ? 'Veille annulée' : 'Pas assez de sources pour le recoupement.');
              return;
            }

            // Step 3: crosscheck synthesis (1 cascade call)
            setDeepResearchProgress({ current: angles.length + 1, total: angles.length + 2, topic: 'Recoupement des sources…' });
            setToast('Recoupement en cours…');
            const { synthesis } = await cortexClient.multiResearchCrosscheck(
              subject,
              sourceResults.map(s => ({ angle: s.angle, content: s.content })),
              detailLevel,
            );

            // Build full content: synthesis + raw sources per angle
            const allSources = sourceResults.flatMap(s => s.sources);
            const uniqueSources = allSources.filter((s, i) => allSources.findIndex(x => x.url === s.url) === i);

            const rawSourcesSections = sourceResults.map(s =>
              `### ${s.angle}\n${s.content.slice(0, 1200)}\n${s.sources.length > 0 ? '\n' + s.sources.map(x => `- [${x.title}](${x.url})`).join('\n') : ''}`,
            ).join('\n\n');

            const fullContent = [
              `# Veille multi-sources — ${subject}`,
              `*${sourceResults.length} angles croisés · ${uniqueSources.length} sources web · ${date}*`,
              '',
              synthesis,
              '',
              '---',
              '## 📚 Détail par angle',
              '',
              rawSourcesSections,
              '',
              '---',
              `*Généré par IA le ${date} — vérifier via les sources avant toute action.*`,
            ].join('\n');

            const page = await createPageFromData({
              title: `Veille multi-sources : ${subject} — ${date}`,
              kind:  'recherche',
              blocks: createContentBlocks(fullContent, subject),
              metadata: { subject, detailLevel, sources: uniqueSources },
            });
            cortex.scheduleIndex(page);
            setSelectedId(page.id);
            setDeepResearchProgress(null);
            const warn = groundingFailed > 0 ? ` (${groundingFailed} angle(s) échoué(s))` : '';
            setToast(`Veille multi-sources créée · ${sourceResults.length} angles · ${uniqueSources.length} sources${warn}`);
          } catch (e) {
            setDeepResearchProgress(null);
            setToast(`Veille multi-sources échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
          }
        }}
        onResearch={async (subject, mode, detailLevel = 'synthese') => {
          const date        = new Date().toLocaleDateString('fr-FR');
          const modeLabel   = mode === 'actualite' ? 'Actualité' : 'Synthèse';
          const titlePrefix = mode === 'actualite' ? 'Actualité' : 'Synthèse';
          setToast('Veille en cours…');
          void cortexClient.setVeilleSettings(detailLevel).catch(() => null);
          try {
            const result = await cortexClient.research(subject, mode, detailLevel);
            let content = result.content;
            if (result.sources.length > 0) {
              content += '\n\n---\n**Sources :**\n' +
                result.sources.map(s => `- [${s.title}](${s.url})`).join('\n');
            }
            content += `\n\n---\n*Généré par IA (${result.model}) le ${date} — à vérifier via les sources.*`;
            if (result.warning) content += `\n\n⚠️ ${result.warning}`;
            const page = await createPageFromData({
              title:  `${titlePrefix} : ${subject} — ${date}`,
              kind:   'recherche',
              blocks: createContentBlocks(content, subject),
              metadata: { subject, detailLevel, sources: result.sources ?? [] },
            });
            cortex.scheduleIndex(page);
            setSelectedId(page.id);
            setToast(`Veille créée · ${modeLabel}`);
          } catch (e) {
            setToast(`Veille échouée : ${e instanceof Error ? e.message : 'Erreur'}`);
          }
        }}
      />

      {/* ── Deep research progress indicator ── */}
      {deepResearchProgress && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 500,
          background: '#1a1030', border: '1px solid rgba(167,139,250,0.25)',
          borderRadius: 12, padding: '14px 18px', maxWidth: 340,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span className="font-mono" style={{ color: '#a78bfa', fontSize: 10, letterSpacing: '0.12em' }}>
              ⌖ VEILLE APPROFONDIE
            </span>
            <button
              type="button"
              onClick={() => { deepResearchCancelRef.current = true; }}
              className="font-mono"
              style={{
                color: '#5a4a7a', background: 'none', cursor: 'pointer', fontSize: 10,
                padding: '2px 7px', borderRadius: 4, border: '1px solid #3d2d5a',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#ff4dcb'; e.currentTarget.style.borderColor = '#ff4dcb'; }}
              onMouseLeave={e => { e.currentTarget.style.color = '#5a4a7a'; e.currentTarget.style.borderColor = '#3d2d5a'; }}
            >
              Annuler
            </button>
          </div>
          {deepResearchProgress.total > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span className="font-mono" style={{
                  color: '#c8b8e8', fontSize: 11, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }}>
                  {deepResearchProgress.topic}
                </span>
                <span className="font-mono" style={{ color: '#7060a0', fontSize: 10, flexShrink: 0 }}>
                  {deepResearchProgress.current}/{deepResearchProgress.total}
                </span>
              </div>
              <div style={{ height: 3, background: 'rgba(167,139,250,0.12)', borderRadius: 2 }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  background: 'linear-gradient(90deg, #a78bfa, #7c3aed)',
                  width: `${Math.round((deepResearchProgress.current / deepResearchProgress.total) * 100)}%`,
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Global video player overlay (triggered by "lis" console command) ── */}
      {activeVideo && (
        <div
          onClick={() => setActiveVideo(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(4,2,12,0.88)',
            backdropFilter: 'blur(12px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 720, width: '100%' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: '#b0a0d0', fontSize: 13, fontFamily: 'Space Grotesk, sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>
                {activeVideo.title}
              </span>
              <button
                type="button"
                onClick={() => setActiveVideo(null)}
                style={{ background: 'none', border: 'none', color: '#7060a0', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}
                onMouseEnter={e => { e.currentTarget.style.color = '#ff4dcb'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#7060a0'; }}
                title="Fermer"
              >×</button>
            </div>
            <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0, borderRadius: 10, overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.7)' }}>
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${activeVideo.videoId}?autoplay=1`}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                title={activeVideo.title}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Gesture camera overlay ───────────────────────────────────────────── */}
      <GestureOverlay
        gestureState={gesture.gestureState}
        lastGesture={gesture.lastGesture}
        error={gesture.error}
        videoRef={gesture.videoRef}
        onToggle={gesture.toggle}
        debugEnabled={gesture.debugEnabled}
        onToggleDebug={gesture.toggleDebug}
        debugInfo={gesture.debugInfo}
        mode={gesture.mode}
        onModeChange={gesture.setCameraMode}
        onCapturePhoto={handleCameraPhotoCapture}
      />

      {systemOffline && <ShutdownOverlay />}

      {conversationOpen && (
        <ConversationModal
          onClose={() => setConversationOpen(false)}
          onSaveConversation={(messages) => {
            void (async () => {
              const date = new Date().toLocaleDateString('fr-FR');
              const firstUserMsg = messages.find(m => m.role === 'user')?.content ?? 'Conversation';
              const content = messages
                .map(m => `**${m.role === 'user' ? 'Moi' : 'Docteur'} :** ${m.content}`)
                .join('\n\n');
              const page = await createPageFromData({
                title:   firstUserMsg.slice(0, 60),
                kind:    'note',
                blocks:  createContentBlocks(`${content}\n\n---\n**Date :** ${date}`, firstUserMsg),
                private: true,
              });
              setToast('Conversation sauvegardée dans un neurone privé');
              setSelectedId(page.id);
            })();
          }}
        />
      )}

      {visionImageId && (
        <VisionAnalyzeModal
          imageId={visionImageId}
          onClose={() => setVisionImageId(null)}
          onSave={(question, resultText, engine, modelUsed) => {
            void (async () => {
              const date       = new Date().toLocaleDateString('fr-FR');
              const engineLabel = engine === 'ocr' ? `OCR (${modelUsed})` : `vision (${modelUsed})`;
              const resultLabel = engine === 'ocr' ? 'Texte extrait' : 'Réponse';
              const content = `**${resultLabel} :**\n${resultText}\n\n---\n**Moteur :** ${engineLabel}\n**Date :** ${date}\n**Analyse locale — résultat indicatif, à vérifier.**`;
              const page = await createPageFromData({
                title:  question || 'Analyse d\'image',
                kind:   'question',
                blocks: [
                  { id: generateId(), type: 'image', content: visionImageId },
                  ...createContentBlocks(content, question || 'Analyse d\'image'),
                ],
              });
              cortex.scheduleIndex(page);
            })();
          }}
        />
      )}

      {/* ── Screen share overlay ─────────────────────────────────────────────── */}
      <ScreenShareOverlay
        state={screenShare.state}
        error={screenShare.error}
        videoRef={screenShare.videoRef}
        onCapture={handleScreenCapture}
        onStop={screenShare.stop}
      />

      {screenCaptureImage && (
        <ScreenCaptureModal
          imageDataUrl={screenCaptureImage}
          onClose={() => setScreenCaptureImage(null)}
          onSaveImage={handleScreenSaveImage}
          onSaveText={handleScreenSaveText}
          onAnalyzeImage={handleScreenAnalyzeImage}
        />
      )}

      {/* ── Voice indicator (floating, when enabled) ─────────────────────────── */}
      {voiceSettings?.enabled && (
        <VoiceIndicator
          state={voice.state}
          pendingText={voice.pendingText}
          setPendingText={voice.setPendingText}
          error={voice.error}
          onMicClick={voice.triggerManual}
          onConfirm={voice.confirmCommand}
          onCancel={voice.cancelCommand}
        />
      )}

      {/* ── Local network banner ─────────────────────────────────────────────── */}
      {localNetworkIp && showLocalBanner && (
        <div className="local-network-banner">
          <span>📱 Accès mobile actif — </span>
          <strong>http://{localNetworkIp}:5173</strong>
          <button
            type="button"
            className="local-network-banner__close"
            onClick={() => setShowLocalBanner(false)}
            aria-label="Fermer"
          >×</button>
        </div>
      )}

      {/* ── Mobile FABs ──────────────────────────────────────────────────────── */}
      {isMobile && !selectedId && (
        <div className="mobile-fab-group">
          <button
            type="button"
            className={`mobile-fab mobile-fab--brain${showMobileBrain ? ' mobile-fab--active' : ''}`}
            onClick={() => setShowMobileBrain(v => !v)}
            aria-label="Cortex 3D"
            title={showMobileBrain ? 'Masquer le cortex 3D' : 'Afficher le cortex 3D'}
          >🧠</button>
          <button
            type="button"
            className="mobile-fab mobile-fab--console"
            onClick={() => setConsoleOpen(v => !v)}
            aria-label="Ouvrir la console"
            title="Rechercher / poser une question"
          >🔍</button>
          <button
            type="button"
            className="mobile-fab mobile-fab--capture"
            onClick={() => setCaptureOpen(true)}
            aria-label="Capturer"
            title="Capturer un lien ou du texte"
          >＋</button>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function hexRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}
