import { useState, useRef, useCallback, useEffect } from 'react';

export type ScreenShareState = 'idle' | 'active' | 'error';

// Turns a getDisplayMedia failure into an explicit, actionable message — never silent.
function describeScreenShareError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : (e as { name?: string })?.name;
  const msg  = e instanceof Error ? e.message : String(e);
  switch (name) {
    case 'NotAllowedError':
      return 'Partage refusé ou annulé';
    case 'NotFoundError':
      return 'Aucun écran ou fenêtre disponible à partager';
    case 'NotReadableError':
      return 'Écran inaccessible (déjà capturé par une autre application ?)';
    case 'AbortError':
      return 'Partage interrompu';
    default:
      return `Partage d'écran : ${msg.slice(0, 120)}`;
  }
}

export function useScreenShare() {
  const [state, setState] = useState<ScreenShareState>('idle');
  const [error, setError] = useState<string | null>(null);

  const videoRef  = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    // Stopping every track is what actually ends the browser's "sharing" state
    // and its own "stop sharing" indicator bar — never just hide the preview.
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('idle');
    setError(null);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 10, max: 15 } }, // static screenshots — no need for a high frame rate
        audio: false,
      });
      streamRef.current = stream;
      // The browser's own "Stop sharing" control (or closing the shared tab/app)
      // ends the track directly — react to that so our state never gets stale.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      setState('active');
    } catch (e) {
      setError(describeScreenShareError(e));
      setState('error');
    }
  }, [stop]);

  const toggle = useCallback(() => {
    if (state === 'idle' || state === 'error') void start();
    else stop();
  }, [state, start, stop]);

  // Attach the stream once both the <video> element and the stream exist —
  // decoupled from start()'s async flow (same lesson as the gesture camera:
  // the element may not be mounted yet at the exact moment getDisplayMedia
  // resolves).
  useEffect(() => {
    if (state !== 'active') return;
    const video  = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (video.paused) video.play().catch(() => {});
  }, [state]);

  // Freezes the current frame into a PNG data URL. Nothing here ever leaves
  // the machine — it's a synchronous canvas draw, no network involved.
  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  }, []);

  // Alt+S global shortcut — mirrors Alt+C (camera) / Alt+M (voice)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  useEffect(() => () => { stop(); }, [stop]);

  return { state, error, videoRef, toggle, stop, captureFrame };
}
