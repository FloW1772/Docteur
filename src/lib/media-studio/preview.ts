// [Media Studio V1] Pure model of the in-browser preview. It mirrors the export plan of cortex-server
// (lib/media-studio.js buildExportArgs): video clips back to back, audio clips at their absolute position,
// gain = clip volume × track volume (0 when muted), linear fades, audio past the sequence end is cut.
// The browser can only play up to 100 % volume: louder gains are shown, played at 100 % (export applies them).
import type { MediaClip, MediaProject } from '../cortex/client';

export interface PreviewVideo { clipId: string; assetId: string; kind: 'video' | 'image'; offsetMs: number; gain: number; localMs: number; durationMs: number }
export interface PreviewAudio { clipId: string; assetId: string; offsetMs: number; gain: number }
export interface PreviewFrame { video: PreviewVideo | null; audio: PreviewAudio[]; durationMs: number; ended: boolean }

const clipMs = (c: Pick<MediaClip, 'inMs' | 'outMs'>) => c.outMs - c.inMs;

/** Fade envelope (0..1) at `localMs` inside a clip of `durationMs`. */
export function fadeEnvelope(localMs: number, durationMs: number, fadeInMs: number, fadeOutMs: number): number {
  let g = 1;
  if (fadeInMs > 0 && localMs < fadeInMs) g = Math.min(g, Math.max(0, localMs / fadeInMs));
  if (fadeOutMs > 0 && localMs > durationMs - fadeOutMs) g = Math.min(g, Math.max(0, (durationMs - localMs) / fadeOutMs));
  return g;
}

export function sequenceDurationMs(project: Pick<MediaProject, 'clips'>): number {
  return project.clips.filter(c => c.trackId === 'V1').reduce((t, c) => t + clipMs(c), 0);
}

/** What should be visible / audible at time `tMs` of the sequence. */
export function previewFrameAt(project: Pick<MediaProject, 'clips' | 'tracks' | 'assets'>, tMs: number): PreviewFrame {
  const durationMs = sequenceDurationMs(project);
  const vTrack = project.tracks.find(t => t.id === 'V1');
  const aTrack = project.tracks.find(t => t.id === 'A1');
  const kindOf = (assetId: string) => project.assets.find(a => a.id === assetId);
  if (tMs < 0 || tMs >= durationMs) return { video: null, audio: [], durationMs, ended: tMs >= durationMs };
  let start = 0;
  let video: PreviewVideo | null = null;
  for (const c of project.clips.filter(x => x.trackId === 'V1')) {
    const d = clipMs(c);
    if (tMs < start + d) {
      const asset = kindOf(c.assetId);
      const local = tMs - start;
      const base = vTrack?.muted || c.muted || asset?.kind === 'image' || !asset?.hasAudio ? 0 : c.volume * (vTrack?.volume ?? 1);
      video = { clipId: c.id, assetId: c.assetId, kind: asset?.kind === 'image' ? 'image' : 'video', offsetMs: c.inMs + local, gain: base * fadeEnvelope(local, d, c.fadeInMs, c.fadeOutMs), localMs: local, durationMs: d };
      break;
    }
    start += d;
  }
  const audio: PreviewAudio[] = [];
  if (!aTrack?.muted) {
    for (const c of project.clips.filter(x => x.trackId === 'A1')) {
      const s = c.startMs ?? 0;
      const d = clipMs(c);
      if (c.muted || c.volume <= 0 || tMs < s || tMs >= s + d) continue;
      const local = tMs - s;
      audio.push({ clipId: c.id, assetId: c.assetId, offsetMs: c.inMs + local, gain: c.volume * (aTrack?.volume ?? 1) * fadeEnvelope(local, d, c.fadeInMs, c.fadeOutMs) });
    }
  }
  return { video, audio, durationMs, ended: false };
}

/** HTMLMediaElement volume (0..1). */
export const playableVolume = (gain: number) => Math.max(0, Math.min(1, gain));

export function formatTimecode(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const d = Math.floor((t % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}
