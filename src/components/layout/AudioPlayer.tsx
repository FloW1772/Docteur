import { useEffect, useRef, useState, useCallback } from 'react';
import { Music, Play, Pause, SkipForward, Volume2, VolumeX, Radio, FolderOpen, AlertTriangle } from 'lucide-react';
import { cortexClient, resolveApiUrl } from '../../lib/cortex/client';
import type { AudioPlayerSettings, AudioLocalFile, AudioRadioPreset } from '../../lib/cortex/client';

const VOLUME_KEY    = 'docteur_audio_volume';
const COLLAPSED_KEY = 'docteur_audio_collapsed';

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 0.5;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
  } catch {
    return 0.5;
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== 'expanded';
  } catch {
    return true;
  }
}

export interface AudioPlayerHandle {
  togglePlayPause: () => void;
}

interface Props {
  registerToggle?: (fn: () => void) => void;
}

export default function AudioPlayer({ registerToggle }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [expanded, setExpanded] = useState(() => !readCollapsed());
  const [playing, setPlaying]   = useState(false);
  const [volume, setVolume]     = useState(readVolume);
  const [muted, setMuted]       = useState(false);

  const [settings, setSettings] = useState<AudioPlayerSettings | null>(null);
  const [localFiles, setLocalFiles] = useState<AudioLocalFile[]>([]);
  const [playOrder, setPlayOrder]   = useState<number[]>([]);
  const [trackIdx, setTrackIdx]     = useState(0);
  const [error, setError]           = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const wantsPlaying = useRef(false);
  const lastSavedSettings = useRef<Partial<AudioPlayerSettings> | null>(null);

  // ── Lazy settings load — only when player is first opened ─────────────────
  const ensureLoaded = useCallback(() => {
    if (loadedOnce) return;
    setLoadedOnce(true);
    void cortexClient.getAudioPlayerSettings().then(s => {
      setSettings(s);
      lastSavedSettings.current = { source: s.source, selectedRadioId: s.selectedRadioId, localFolder: s.localFolder };
    }).catch(() => {
      setError('Réglages du lecteur indisponibles.');
    });
  }, [loadedOnce]);

  // N'écrire au backend que si la valeur a réellement changé depuis la
  // dernière sauvegarde — évite les PUT répétés (ex. boucle d'erreur radio).
  const saveSettings = useCallback((updates: Partial<Omit<AudioPlayerSettings, 'presets'>>) => {
    const last = lastSavedSettings.current ?? {};
    const changed = (Object.keys(updates) as (keyof typeof updates)[]).some(
      k => JSON.stringify(updates[k]) !== JSON.stringify(last[k as keyof AudioPlayerSettings]),
    );
    if (!changed) return;
    lastSavedSettings.current = { ...last, ...updates };
    void cortexClient.setAudioPlayerSettings(updates).catch(() => {
      setError('Impossible d\'enregistrer les réglages audio.');
    });
  }, []);

  useEffect(() => {
    if (expanded) ensureLoaded();
  }, [expanded, ensureLoaded]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, expanded ? 'expanded' : 'collapsed'); } catch { /* ignore */ }
  }, [expanded]);

  useEffect(() => {
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* ignore */ }
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  // ── Local files list — fetched once settings resolve and source is local ──
  useEffect(() => {
    if (!settings || settings.source !== 'local' || !settings.localFolder) return;
    void cortexClient.getAudioLocalFiles().then(res => {
      setLocalFiles(res.files);
      setPlayOrder(shuffleArray(res.files.map((_, i) => i)));
      if (res.error) setError(res.error);
    }).catch(() => setError('Impossible de lire le dossier local.'));
  }, [settings]);

  const currentPreset: AudioRadioPreset | null = (() => {
    if (!settings || settings.source !== 'radio') return null;
    const all = [
      ...(settings.presets ?? []),
      ...(settings.customStreams ?? []).map((s, i) => ({ id: `custom-${i}`, name: s.name, url: s.url })),
    ];
    return all.find(p => p.id === settings.selectedRadioId) ?? all[0] ?? null;
  })();

  const currentLocalTrack: AudioLocalFile | null = (() => {
    if (!settings || settings.source !== 'local' || localFiles.length === 0) return null;
    const idx = playOrder[trackIdx] ?? 0;
    return localFiles[idx] ?? null;
  })();

  const currentSrc = settings?.source === 'local'
    ? (currentLocalTrack?.url ? resolveApiUrl(currentLocalTrack.url) : null)
    : (currentPreset?.url ?? null);
  const currentTitle = settings?.source === 'local' ? (currentLocalTrack?.name ?? '') : (currentPreset?.name ?? '');

  // Le changement de `src` via React ne recharge pas toujours la ressource
  // média (surtout sur un flux Icecast sans src initial) — appeler load()
  // explicitement, puis relancer la lecture si l'utilisateur était en lecture.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentSrc) return;
    audio.load();
    audio.volume = muted ? 0 : volume;
    if (wantsPlaying.current) {
      void audio.play().catch(() => setError('Lecture impossible.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSrc]);

  function playNext() {
    if (!settings) return;
    if (settings.source === 'local') {
      if (playOrder.length === 0) return;
      setTrackIdx(i => (i + 1) % playOrder.length);
    } else {
      const all = [
        ...(settings.presets ?? []),
        ...(settings.customStreams ?? []).map((s, i) => ({ id: `custom-${i}`, name: s.name, url: s.url })),
      ];
      const idx = all.findIndex(p => p.id === settings.selectedRadioId);
      const next = all[(idx + 1) % all.length];
      if (next) {
        setSettings({ ...settings, selectedRadioId: next.id });
        saveSettings({ selectedRadioId: next.id });
      }
    }
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      wantsPlaying.current = false;
      audio.pause();
    } else {
      wantsPlaying.current = true;
      setError(null);
      void audio.play().catch(() => setError('Lecture impossible.'));
    }
  }

  useEffect(() => {
    registerToggle?.(togglePlayPause);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerToggle, playing]);

  function switchSource(source: 'local' | 'radio') {
    if (!settings) return;
    audioRef.current?.pause();
    setSettings({ ...settings, source });
    saveSettings({ source });
  }

  const collapsedGlyph = playing ? <Pause size={13} /> : <Play size={13} />;

  return (
    <div style={{ position: 'fixed', bottom: 14, right: 14, zIndex: 60 }}>
      <audio
        ref={audioRef}
        src={currentSrc ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          if (currentSrc) {
            // Une seule tentative par clic utilisateur — pas de retry en
            // boucle qui spammait /api/audio-player/settings via playNext().
            wantsPlaying.current = false;
            setError(settings?.source === 'radio' ? 'Radio actuellement indisponible.' : 'Flux indisponible.');
            setPlaying(false);
          }
        }}
        onEnded={() => { if (settings?.source === 'local') playNext(); }}
      />

      {!expanded ? (
        <button
          type="button"
          title="Lecteur audio (Alt+A)"
          onClick={() => setExpanded(true)}
          className="glass"
          style={{
            width: 34, height: 34, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: `1px solid ${playing ? 'rgba(61,255,170,0.35)' : 'rgba(255,255,255,0.08)'}`,
            color: playing ? '#3dffaa' : '#7a6c9a',
            cursor: 'pointer',
          }}
        >
          {collapsedGlyph}
        </button>
      ) : (
        <div
          className="glass"
          style={{
            width: 260, borderRadius: 10,
            border: '1px solid rgba(94,231,255,0.15)',
            padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Music size={13} style={{ color: '#5ee7ff' }} />
              <span className="font-mono text-xs" style={{ color: '#5ee7ff', letterSpacing: '0.15em' }}>AUDIO</span>
            </div>
            <button type="button" onClick={() => setExpanded(false)} className="font-mono text-xs" style={{ color: '#5a4a7a' }}>
              réduire
            </button>
          </div>

          {settings && (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => switchSource('local')}
                className="font-mono text-xs flex items-center gap-1 px-2 py-1 rounded"
                style={{
                  flex: 1, justifyContent: 'center',
                  background: settings.source === 'local' ? 'rgba(61,255,170,0.1)' : 'transparent',
                  border: `1px solid ${settings.source === 'local' ? 'rgba(61,255,170,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  color: settings.source === 'local' ? '#3dffaa' : '#7a6c9a',
                }}
              >
                <FolderOpen size={11} /> Local
              </button>
              <button
                type="button"
                onClick={() => switchSource('radio')}
                className="font-mono text-xs flex items-center gap-1 px-2 py-1 rounded"
                style={{
                  flex: 1, justifyContent: 'center',
                  background: settings.source === 'radio' ? 'rgba(61,255,170,0.1)' : 'transparent',
                  border: `1px solid ${settings.source === 'radio' ? 'rgba(61,255,170,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  color: settings.source === 'radio' ? '#3dffaa' : '#7a6c9a',
                }}
              >
                <Radio size={11} /> Radio
              </button>
            </div>
          )}

          <div style={{ minHeight: 16 }}>
            <p className="font-mono text-xs truncate" style={{ color: '#e2e8f0' }} title={currentTitle}>
              {currentTitle || (settings?.source === 'local' ? 'Aucun dossier configuré' : 'Aucun flux')}
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={11} style={{ color: '#ff4d58', flexShrink: 0 }} />
              <span className="font-mono text-[10px]" style={{ color: '#ff4d58' }}>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlayPause}
              disabled={!currentSrc}
              title="Lecture / pause (Alt+A)"
              style={{
                width: 28, height: 28, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid rgba(94,231,255,0.25)',
                color: currentSrc ? '#5ee7ff' : '#3d3060',
                cursor: currentSrc ? 'pointer' : 'default',
                background: 'transparent',
              }}
            >
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>

            <button
              type="button"
              onClick={playNext}
              disabled={!currentSrc}
              title="Suivant"
              style={{ color: currentSrc ? '#7a6c9a' : '#3d3060', background: 'transparent', border: 'none', cursor: currentSrc ? 'pointer' : 'default' }}
            >
              <SkipForward size={14} />
            </button>

            <button
              type="button"
              onClick={() => setMuted(m => !m)}
              title={muted ? 'Réactiver le son' : 'Couper le son'}
              style={{ color: '#7a6c9a', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              {muted || volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>

            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => { setMuted(false); setVolume(Number(e.target.value)); }}
              style={{ flex: 1, accentColor: '#5ee7ff' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
