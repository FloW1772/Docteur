// [Media Studio V1] Sequence preview in the browser: plays the timeline as the export will render it (video
// sequence, audio track at its positions, volumes, mutes, fades). Lightweight: one <video>, one <img>, one
// <audio> per audio clip, driven by a clock; everything stops on unmount. The exported MP4 stays the reference.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, SkipBack } from 'lucide-react';
import type { MediaProject } from '../../lib/cortex/client';
import { formatTimecode, playableVolume, previewFrameAt, sequenceDurationMs } from '../../lib/media-studio/preview';

interface Props {
  project: MediaProject;
  assetUrl: (assetId: string) => string;
}

const DRIFT_S = 0.35;

export default function SequencePreview({ project, assetUrl }: Props) {
  const [playing, setPlaying] = useState(false);
  const [tMs, setTMs] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const origin = useRef(0);
  const raf = useRef<number | null>(null);
  const loadedAsset = useRef<string | null>(null);
  const tRef = useRef(0);
  const durationMs = sequenceDurationMs(project);
  const frame = useMemo(() => previewFrameAt(project, tMs), [project, tMs]);
  const audioClips = project.clips.filter(c => c.trackId === 'A1');
  const [w, h] = project.settings.resolution.split('x').map(Number);

  const pauseAll = useCallback(() => {
    videoRef.current?.pause();
    audioRefs.current.forEach(a => a.pause());
  }, []);

  /** Brings the media elements to time t (seek only when they drifted). */
  const sync = useCallback((t: number, play: boolean) => {
    const f = previewFrameAt(project, t);
    const v = videoRef.current;
    if (v) {
      if (f.video?.kind === 'video') {
        if (loadedAsset.current !== f.video.assetId) { v.src = assetUrl(f.video.assetId); loadedAsset.current = f.video.assetId; }
        const target = f.video.offsetMs / 1000;
        if (Math.abs(v.currentTime - target) > DRIFT_S) { try { v.currentTime = target; } catch { /* not seekable yet */ } }
        v.volume = playableVolume(f.video.gain);
        v.muted = f.video.gain <= 0;
        if (play && v.paused) void v.play().catch(() => {});
        if (!play) v.pause();
      } else v.pause();
    }
    const active = new Map(f.audio.map(a => [a.clipId, a]));
    audioRefs.current.forEach((el, clipId) => {
      const a = active.get(clipId);
      if (!a) { el.pause(); return; }
      const target = a.offsetMs / 1000;
      if (Math.abs(el.currentTime - target) > DRIFT_S) { try { el.currentTime = target; } catch { /* not seekable yet */ } }
      el.volume = playableVolume(a.gain);
      if (play && el.paused) void el.play().catch(() => {});
      if (!play) el.pause();
    });
    return f;
  }, [project, assetUrl]);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPlaying(false);
    pauseAll();
  }, [pauseAll]);

  const tick = useCallback(() => {
    const t = performance.now() - origin.current;
    tRef.current = t;
    const f = sync(t, true);
    if (f.ended || t >= durationMs) { setTMs(durationMs); stop(); return; }
    setTMs(t);
    raf.current = requestAnimationFrame(tick);
  }, [sync, durationMs, stop]);

  const play = () => {
    if (durationMs <= 0) return;
    const from = tMs >= durationMs ? 0 : tMs;
    origin.current = performance.now() - from;
    setPlaying(true);
    raf.current = requestAnimationFrame(tick);
  };
  const seek = (t: number) => {
    const clamped = Math.max(0, Math.min(durationMs, t));
    setTMs(clamped);
    tRef.current = clamped;
    origin.current = performance.now() - clamped;
    sync(clamped, playing);
  };

  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); pauseAll(); }, [pauseAll]);
  // the timeline changed under the preview (edit): keep the position, re-sync paused
  useEffect(() => { if (!playing) sync(Math.min(tRef.current, durationMs), false); }, [project, playing, sync, durationMs]);

  const imageAsset = frame.video?.kind === 'image' ? frame.video.assetId : null;
  return (
    <section className="ms-preview" aria-label="Aperçu de la séquence" data-testid="ms-sequence-preview" data-playing={playing ? 'true' : 'false'} data-current-clip={frame.video?.clipId ?? ''}>
      <div className="ms-stage" style={{ aspectRatio: `${w} / ${h}` }}>
        <video ref={videoRef} className="ms-stage-media" playsInline preload="auto" style={{ visibility: frame.video?.kind === 'video' ? 'visible' : 'hidden' }} aria-hidden={frame.video?.kind !== 'video'} />
        {imageAsset && <img className="ms-stage-media" src={assetUrl(imageAsset)} alt="" />}
        {!frame.video && <span className="ms-stage-empty">{durationMs === 0 ? 'Séquence vide' : frame.ended ? 'Fin de la séquence' : ''}</span>}
      </div>
      {audioClips.map(c => (
        <audio key={c.id} preload="auto" src={assetUrl(c.assetId)} ref={el => { if (el) audioRefs.current.set(c.id, el); else audioRefs.current.delete(c.id); }} />
      ))}
      <div className="ms-transport">
        <button type="button" className="tb-icon" aria-label="Revenir au début" onClick={() => seek(0)}><SkipBack size={13} aria-hidden="true" /></button>
        <button type="button" className="tb-btn" data-testid="ms-preview-play" disabled={durationMs <= 0} onClick={() => (playing ? stop() : play())}>
          {playing ? <><Pause size={12} aria-hidden="true" /> Pause</> : <><Play size={12} aria-hidden="true" /> Lire la séquence</>}
        </button>
        <input type="range" min={0} max={Math.max(1, durationMs)} step={50} value={Math.min(tMs, durationMs)} onChange={e => seek(Number(e.target.value))} aria-label="Position dans la séquence" disabled={durationMs <= 0} />
        <span className="ms-time" data-testid="ms-preview-time">{formatTimecode(tMs)} / {formatTimecode(durationMs)}</span>
      </div>
      <p className="tb-hint">Aperçu navigateur (volumes plafonnés à 100 %) — le fichier exporté fait foi.</p>
    </section>
  );
}
