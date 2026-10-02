// Pure view-model of a running YouTube discovery. App.tsx feeds it NDJSON events (accumulated in a ref, flushed to React
// state a few times per second) so a 2 500+ item crawl never causes one setState per item.
import type { YouTubeDiscoveryEvent, YouTubeDiscoveryMode, YouTubeSourceTab } from '../cortex/client';
import type { YouTubeDiscoveryInput } from './discovery-input';

export type DiscoveryStatus = 'analyzing' | 'running' | 'finalizing' | 'done' | 'cancelled' | 'timeout' | 'error';
export interface DiscoveryPhaseView { tab: YouTubeSourceTab; status: 'pending' | 'running' | 'done' | 'unavailable'; count: number; pages: number }
export interface DiscoveryView {
  input: string;
  status: DiscoveryStatus;
  mode: YouTubeDiscoveryMode | null;
  handle: string | null;
  channelLabel: string;
  phases: DiscoveryPhaseView[];
  currentTab: YouTubeSourceTab | null;
  total: number;
  startedAt: number;
  endedAt: number | null;
  message: string | null;
}

export const TAB_LABEL: Record<YouTubeSourceTab, string> = { videos: 'Vidéos', shorts: 'Shorts', streams: 'Streams', playlist: 'Playlist' };
const SEARCH_LABEL: Record<YouTubeSourceTab, string> = { videos: 'vidéos', shorts: 'Shorts', streams: 'streams', playlist: 'playlist' };
export const MODE_LABEL: Record<YouTubeDiscoveryMode, string> = {
  CHANNEL_ALL_MEDIA: 'Tous les médias',
  CHANNEL_VIDEOS_ONLY: 'Vidéos uniquement',
  CHANNEL_SHORTS_ONLY: 'Shorts uniquement',
  CHANNEL_STREAMS_ONLY: 'Streams uniquement',
  PLAYLIST_ONLY: 'Playlist',
  SINGLE_VIDEO: 'Vidéo',
  SINGLE_SHORT: 'Short',
  CHANNEL_LIVE: 'Direct',
};
const TABS_BY_MODE: Partial<Record<YouTubeDiscoveryMode, YouTubeSourceTab[]>> = {
  CHANNEL_ALL_MEDIA: ['videos', 'shorts', 'streams'],
  CHANNEL_VIDEOS_ONLY: ['videos'],
  CHANNEL_SHORTS_ONLY: ['shorts'],
  CHANNEL_STREAMS_ONLY: ['streams'],
  PLAYLIST_ONLY: ['playlist'],
};

function phasesFor(mode: YouTubeDiscoveryMode | null, tabs?: YouTubeSourceTab[]): DiscoveryPhaseView[] {
  const list = tabs ?? (mode ? TABS_BY_MODE[mode] ?? [] : []);
  return list.map(tab => ({ tab, status: 'pending', count: 0, pages: 0 }));
}

export function createDiscoveryView(request: Pick<YouTubeDiscoveryInput, 'input' | 'mode' | 'handle'>, now = Date.now()): DiscoveryView {
  return {
    input: request.input,
    status: 'analyzing',
    mode: request.mode,           // predicted from the URL for the first paint; the server's `mode` event confirms it
    handle: request.handle,
    channelLabel: request.handle ?? request.input,
    phases: phasesFor(request.mode),
    currentTab: null,
    total: 0,
    startedAt: now,
    endedAt: null,
    message: null,
  };
}

function patchPhase(view: DiscoveryView, tab: YouTubeSourceTab, patch: Partial<DiscoveryPhaseView>): DiscoveryPhaseView[] {
  return view.phases.map(phase => (phase.tab === tab ? { ...phase, ...patch } : phase));
}

export function applyDiscoveryEvent(view: DiscoveryView, event: YouTubeDiscoveryEvent, now = Date.now()): DiscoveryView {
  switch (event.type) {
    case 'start':
      return view;
    case 'mode':
      return { ...view, status: 'running', mode: event.mode, handle: event.handle ?? view.handle, channelLabel: event.handle ?? view.channelLabel, phases: phasesFor(event.mode, event.sources) };
    case 'phase_start':
      return { ...view, status: 'running', currentTab: event.tab, phases: patchPhase(view, event.tab, { status: 'running' }) };
    case 'progress':
      return { ...view, currentTab: event.tab, total: event.total, phases: patchPhase(view, event.tab, { count: event.count, pages: event.pages }) };
    case 'items_batch':
      return { ...view, total: event.total };
    case 'phase_done': {
      const last = view.phases.length > 0 && view.phases[view.phases.length - 1].tab === event.tab;
      return {
        ...view, total: event.total, currentTab: last ? null : view.currentTab,
        status: last ? 'finalizing' : view.status,
        phases: patchPhase(view, event.tab, { status: event.available ? 'done' : 'unavailable', count: event.count, pages: event.pages }),
      };
    }
    case 'done':
      return { ...view, status: 'done', total: event.total, currentTab: null, endedAt: now, message: null };
    case 'cancelled':
      return { ...view, status: 'cancelled', currentTab: null, endedAt: now, message: null };
    case 'error':
      return {
        ...view, status: event.name === 'TimeoutError' ? 'timeout' : 'error', currentTab: null, endedAt: now,
        message: event.message,
      };
  }
}

export function failureView(view: DiscoveryView, error: Error, now = Date.now()): DiscoveryView {
  if (error.name === 'AbortError') return { ...view, status: 'cancelled', currentTab: null, endedAt: now };
  return { ...view, status: error.name === 'TimeoutError' ? 'timeout' : 'error', currentTab: null, endedAt: now, message: error.message };
}

export const isActive = (view: DiscoveryView): boolean => view.status === 'analyzing' || view.status === 'running' || view.status === 'finalizing';

export function discoveryStatusText(view: DiscoveryView): string {
  switch (view.status) {
    case 'analyzing': return 'Analyse de l’URL…';
    case 'running':
      return view.currentTab ? `Recherche ${SEARCH_LABEL[view.currentTab]}…` : `Chaîne détectée : ${view.channelLabel}`;
    case 'finalizing': return 'Finalisation…';
    case 'done': return `Terminé : ${view.total} élément${view.total > 1 ? 's' : ''}`;
    case 'cancelled': return 'Annulé';
    case 'timeout': return `Timeout : ${view.message ?? 'yt-dlp ne répond plus'}`;
    case 'error': return `Erreur yt-dlp : ${view.message ?? 'échec de la découverte'}`;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${String(seconds % 60).padStart(2, '0')} s` : `${seconds} s`;
}
