import { useEffect, useRef, useState } from 'react';
import { Activity, Bot, Clapperboard, Cog, GraduationCap, HardDrive, HelpCircle, Map, Mountain, ScrollText, Search, Upload, Mic, MicOff, Camera, CameraOff, Zap, ListTodo, Monitor, MonitorOff, Wand2, Library, Image as ImageIcon, NotebookText } from 'lucide-react';
import type { VoiceState } from '../../hooks/useVoiceActivation';
import type { GestureState } from '../../hooks/useGestureCamera';
import type { ScreenShareState } from '../../hooks/useScreenShare';
import type { BatchProgressState } from '../modals/BatchProgressModal';

interface Props {
  readonly pageCount:        number;
  readonly cortexAvailable:  boolean;
  readonly cortexBusy:       boolean;
  readonly cortexQueueSize:  number;
  readonly cortexIndexCount: number;
  readonly isOnline?:        boolean | null;
  readonly onSearchOpen:     () => void;
  readonly onCaptureOpen:    () => void;
  readonly onBackupOpen:     () => void;
  readonly onCorpusOpen:     () => void;
  readonly onActivityLogOpen: () => void;
  readonly onActivityPanelOpen?: () => void;
  readonly activityCount?: number;
  readonly onSettingsOpen:   () => void;
  readonly onHelpOpen:       () => void;
  readonly onRoadmapOpen:    () => void;
  readonly onAgentsOpen:     () => void;
  readonly onVideoSummaryOpen?: () => void;
  readonly onSkillsOpen:     () => void;
  readonly onPromptGeneratorOpen: () => void;
  readonly onKiwixOpen:      () => void;
  readonly onTeacherOpen:    () => void;
  readonly onNotebookOpen:   () => void;
  readonly onImageGeneratorOpen: () => void;
  readonly onTodoOpen:       () => void;
  readonly todoPendingCount?: number;
  readonly voiceEnabled?:    boolean;
  readonly voiceState?:      VoiceState;
  readonly onVoiceClick?:    () => void;
  readonly gestureState?:    GestureState;
  readonly onCameraClick?:   () => void;
  readonly screenShareState?: ScreenShareState;
  readonly onScreenShareClick?: () => void;
  readonly activeBatch?:     BatchProgressState | null;
  readonly batchQueueLength?: number;
  readonly onBatchClick?:    () => void;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

export default function TopBar({
  pageCount,
  cortexAvailable,
  cortexBusy,
  cortexQueueSize,
  cortexIndexCount,
  isOnline,
  onSearchOpen,
  onCaptureOpen,
  onBackupOpen,
  onCorpusOpen,
  onActivityLogOpen,
  onActivityPanelOpen,
  activityCount = 0,
  onSettingsOpen,
  onHelpOpen,
  onRoadmapOpen,
  onAgentsOpen,
  onVideoSummaryOpen,
  onSkillsOpen,
  onPromptGeneratorOpen,
  onTeacherOpen,
  onNotebookOpen,
  onImageGeneratorOpen,
  onKiwixOpen,
  onTodoOpen,
  todoPendingCount = 0,
  voiceEnabled = false,
  voiceState   = 'idle',
  onVoiceClick,
  gestureState = 'idle',
  onCameraClick,
  screenShareState = 'idle',
  onScreenShareClick,
  activeBatch,
  batchQueueLength = 0,
  onBatchClick,
}: Props) {
  const [time, setTime] = useState(() => new Date());
  const [offlinePopover, setOfflinePopover] = useState(false);
  const popoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offline = isOnline === false;

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Clear popover timer on unmount
  useEffect(() => () => { if (popoverTimer.current) clearTimeout(popoverTimer.current); }, []);

  // Close popover when coming back online
  useEffect(() => { if (!offline) setOfflinePopover(false); }, [offline]);

  function toggleOfflinePopover() {
    if (offlinePopover) {
      clearTimeout(popoverTimer.current ?? undefined);
      setOfflinePopover(false);
    } else {
      setOfflinePopover(true);
      popoverTimer.current = setTimeout(() => setOfflinePopover(false), 3_500);
    }
  }

  // ── Cortex badge ──────────────────────────────────────────────────────────
  let cortexLabel: string;
  let cortexColor: string;
  let tooltipText: string;

  if (!cortexAvailable) {
    cortexLabel = 'CORTEX OFF';
    cortexColor = '#ff4d58';
    tooltipText = 'Serveur cognitif déconnecté';
  } else if (cortexBusy) {
    cortexLabel = 'CORTEX BUSY';
    cortexColor = '#ffb547';
    tooltipText = `${cortexIndexCount} en cours · ${cortexQueueSize} en attente`;
  } else {
    cortexLabel = 'CORTEX OK';
    cortexColor = '#3dffaa';
    tooltipText = `${pageCount} neurones indexés`;
  }

  return (
    <header className="glass topbar-hud flex items-center justify-between px-3">
      {/* Brand */}
      <div className="topbar-brand flex items-center gap-3">
        <span
          className="font-grotesk font-bold tracking-widest glow-emerald"
          style={{ color: '#3dffaa', letterSpacing: '0.4em' }}
        >
          DOCTEUR
        </span>
        <span className="font-mono text-xs" style={{ color: '#5ee7ff', letterSpacing: '0.2em' }}>
          v4.7
        </span>
      </div>

      {/* Center status */}
      <div className="topbar-center flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="topbar-heartbeat" aria-hidden="true" />

          {/* Neural active (always) */}
          <span className="font-mono text-xs tracking-[0.24em]" style={{ color: '#5ee7ff' }}>
            NEURAL ACTIVE
          </span>

          {offline ? (
            /* Offline badge — replaces cortex badge, tappable for popover */
            <span className="topbar-offline-badge-wrap">
              <button
                type="button"
                className="topbar-offline-badge font-mono text-xs tracking-[0.24em]"
                onClick={toggleOfflinePopover}
                aria-label="Mode hors-ligne — tap pour plus d'infos"
                title="PC éteint · données locales en lecture seule"
              >
                📴 HORS-LIGNE
              </button>
              {offlinePopover && (
                <div className="topbar-offline-popover" role="status">
                  PC éteint · données locales en lecture seule
                </div>
              )}
            </span>
          ) : (
            /* Normal cortex status badge */
            <span
              className="font-mono text-xs tracking-[0.24em] cortex-badge"
              style={{ color: cortexColor, cursor: 'default', transition: 'color 0.3s' }}
              title={tooltipText}
            >
              {cortexLabel}
            </span>
          )}

          <span className="font-mono text-xs tracking-[0.2em]" style={{ color: '#7a6c9a' }}>
            {pageCount} NEURONES
          </span>
        </div>

        {/* Mini batch indicator — shown when a batch is running and modal is minimized */}
        {activeBatch && (
          <button
            type="button"
            onClick={onBatchClick}
            title="Voir la progression du traitement"
            style={{
              display:        'flex', alignItems: 'center', gap: 6,
              background:     'rgba(94,231,255,0.08)',
              border:         '1px solid rgba(94,231,255,0.2)',
              borderRadius:   6,
              padding:        '3px 10px',
              cursor:         'pointer',
              fontFamily:     'IBM Plex Mono, monospace',
              fontSize:       10,
              color:          '#5ee7ff',
              whiteSpace:     'nowrap',
            }}
          >
            <span
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#5ee7ff',
                animation: 'pulse 1.5s ease-in-out infinite',
                flexShrink: 0,
              }}
            />
            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {activeBatch.operation}
            </span>
            <span style={{ color: '#3dffaa', fontWeight: 600 }}>
              {activeBatch.current}/{activeBatch.total}
            </span>
            {activeBatch.whisperProvider && (
              <span style={{
                flexShrink: 0, fontSize: 9,
                color: activeBatch.whisperProvider === 'groq' ? '#f97316' : '#34d399',
              }}>
                {activeBatch.whisperProvider === 'groq' ? '⚡' : '🔒'}
              </span>
            )}
            {batchQueueLength > 0 && (
              <span style={{
                background: 'rgba(94,231,255,0.15)', borderRadius: 3,
                padding: '1px 4px', fontSize: 9, color: '#5ee7ff', flexShrink: 0,
              }}>
                +{batchQueueLength}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Right: clock + actions */}
      <div className="topbar-right flex items-center gap-2">
        <div className="topbar-clock font-mono text-sm tabular-nums">
          {pad(time.getHours())}
          <span style={{ opacity: 0.55 }}>:</span>
          {pad(time.getMinutes())}
          <span style={{ opacity: 0.55 }}>:</span>
          {pad(time.getSeconds())}
        </div>

        {/* Camera gesture button */}
        {onCameraClick && (() => {
          const CAM_TITLES: Partial<Record<GestureState, string>> = {
            idle:    'Activer la caméra gestuelle (Alt+C)',
            loading: 'Chargement du modèle…',
            active:  'Caméra active — cliquer pour désactiver (Alt+C)',
            error:   'Erreur caméra — cliquer pour réessayer (Alt+C)',
          };
          const CAM_COLORS: Partial<Record<GestureState, string>> = {
            active:  '#3dffaa',
            loading: '#ffb547',
            error:   '#ff4d58',
          };
          const camColor = CAM_COLORS[gestureState];
          return (
            <button
              type="button"
              className={`topbar-action topbar-action--icon${gestureState === 'active' ? ' topbar-action--recording' : ''}`}
              title={CAM_TITLES[gestureState] ?? ''}
              onClick={onCameraClick}
              style={camColor ? { color: camColor } : undefined}
            >
              {gestureState === 'active' ? <Camera size={12} /> : <CameraOff size={12} />}
            </button>
          );
        })()}

        {/* Screen share button */}
        {onScreenShareClick && (() => {
          const SCREEN_TITLES: Partial<Record<ScreenShareState, string>> = {
            idle:   'Partager l\'écran (Alt+S)',
            active: 'Partage actif — cliquer pour désactiver (Alt+S)',
            error:  'Erreur de partage — cliquer pour réessayer (Alt+S)',
          };
          const SCREEN_COLORS: Partial<Record<ScreenShareState, string>> = {
            active: '#5ee7ff',
            error:  '#ff4d58',
          };
          const screenColor = SCREEN_COLORS[screenShareState];
          return (
            <button
              type="button"
              className={`topbar-action topbar-action--icon${screenShareState === 'active' ? ' topbar-action--recording' : ''}`}
              title={SCREEN_TITLES[screenShareState] ?? ''}
              onClick={onScreenShareClick}
              style={screenColor ? { color: screenColor } : undefined}
            >
              {screenShareState === 'active' ? <Monitor size={12} /> : <MonitorOff size={12} />}
            </button>
          );
        })()}

        {voiceEnabled && (() => {
          const VOICE_TITLES: Record<string, string> = {
            idle:           'Activer le micro (Alt+M)',
            'wake-listening': 'En écoute — dites "Hey Docteur"',
            recording:      'Enregistrement…',
            transcribing:   'Transcription…',
            pending:        'Commande en attente',
          };
          const VOICE_COLORS: Record<string, string> = {
            recording:      '#ff4d58',
            'wake-listening': '#3dffaa',
            transcribing:   '#ffb547',
            pending:        '#5ee7ff',
          };
          const voiceColor = VOICE_COLORS[voiceState];
          return (
            <button
              type="button"
              className={`topbar-action topbar-action--icon${voiceState === 'recording' ? ' topbar-action--recording' : ''}`}
              title={VOICE_TITLES[voiceState] ?? ''}
              onClick={onVoiceClick}
              style={voiceColor ? { color: voiceColor } : undefined}
            >
              {voiceState === 'idle' ? <MicOff size={12} /> : <Mic size={12} />}
            </button>
          );
        })()}

        <button className="topbar-action" type="button" title="Ouvrir la console de recherche (Ctrl+L)" onClick={onSearchOpen}>
          <Search size={12} />
          <span>CHERCHER - Ctrl+L</span>
        </button>

        <button className="topbar-action" type="button" title="Capturer une URL ou une note" onClick={onCaptureOpen}>
          <Upload size={12} />
          <span>CAPTURER</span>
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Backup & restauration" onClick={onBackupOpen}>
          <HardDrive size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Corpus de référence (survie, premiers secours…)" onClick={onCorpusOpen}>
          <Mountain size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Journal d'activité" onClick={onActivityLogOpen}>
          <ScrollText size={12} />
        </button>

        {onActivityPanelOpen && (
          <button
            className="topbar-action topbar-action--icon"
            type="button"
            title="Panneau d'activité Cortex"
            onClick={onActivityPanelOpen}
            style={{ position: 'relative' }}
          >
            <Activity size={12} />
            {activityCount > 0 && (
              <span style={{
                position: 'absolute', top: 0, right: 0,
                background: '#5ee7ff', color: '#0a0814',
                borderRadius: '50%', width: 10, height: 10,
                fontSize: 7, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                lineHeight: 1,
              }}>
                {activityCount > 9 ? '9+' : activityCount}
              </span>
            )}
          </button>
        )}

        <button className="topbar-action topbar-action--icon" type="button" title="Agents automatiques" onClick={onAgentsOpen}>
          <Bot size={12} />
        </button>

        {onVideoSummaryOpen && (
          <button className="topbar-action topbar-action--icon" type="button" title="Résumé de vidéo longue" onClick={onVideoSummaryOpen}>
            <Clapperboard size={12} />
          </button>
        )}

        <button className="topbar-action topbar-action--icon" type="button" title="Compétences à la demande" onClick={onSkillsOpen}>
          <Zap size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Générateur de prompts" onClick={onPromptGeneratorOpen}>
          <Wand2 size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Bibliothèque (archives ZIM hors-ligne)" onClick={onKiwixOpen}>
          <Library size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Professeur (apprentissage & révision)" onClick={onTeacherOpen}>
          <GraduationCap size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Notebook local (documents & questions/réponses)" onClick={onNotebookOpen}>
          <NotebookText size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Générateur d'images" onClick={onImageGeneratorOpen}>
          <ImageIcon size={12} />
        </button>

        <button
          className="topbar-action topbar-action--icon"
          type="button"
          title="À faire"
          onClick={onTodoOpen}
          style={{ position: 'relative' }}
        >
          <ListTodo size={12} />
          {todoPendingCount > 0 && (
            <span style={{
              position: 'absolute', top: 0, right: 0,
              background: '#f97316', color: '#fff',
              borderRadius: '50%', width: 10, height: 10,
              fontSize: 7, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              lineHeight: 1,
            }}>
              {todoPendingCount > 9 ? '9+' : todoPendingCount}
            </span>
          )}
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Paramètres du router (Ctrl+,)" onClick={onSettingsOpen}>
          <Cog size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Roadmap du projet" onClick={onRoadmapOpen}>
          <Map size={12} />
        </button>

        <button className="topbar-action topbar-action--icon" type="button" title="Aide — Capacités de Docteur (F1)" onClick={onHelpOpen}>
          <HelpCircle size={12} />
        </button>
      </div>
    </header>
  );
}
