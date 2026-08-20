import { useState, useEffect, useRef, useCallback } from 'react';
import type { VoiceSettings } from '../lib/cortex/client';

export type VoiceState = 'idle' | 'wake-listening' | 'recording' | 'transcribing' | 'pending';

// Destructive commands are always blocked for voice input
const DESTRUCTIVE_WORDS = ['supprime', 'efface', 'delete', 'remove', 'vide', 'clear', 'reset', 'drop', 'destroy', 'réinitialise'];
function isDestructive(text: string): boolean {
  const lower = text.toLowerCase();
  return DESTRUCTIVE_WORDS.some(w => lower.includes(w));
}

const SILENCE_THRESHOLD_RMS  = 0.012;  // amplitude RMS — below this = silence
const SILENCE_DURATION_MS    = 2000;   // 2s of silence stops the recording
const MAX_RECORDING_MS       = 30_000; // hard cap per recording

const SERVER_BASE = `${window.location.protocol}//${window.location.hostname}:3001`;

function computeRms(data: Uint8Array): number {
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length);
}

export function useVoiceActivation({
  settings,
  onCommand,
}: {
  settings: VoiceSettings | null;
  onCommand: (text: string) => void;
}) {
  const [state,        setState]        = useState<VoiceState>('idle');
  const [pendingText,  setPendingText]  = useState<string | null>(null);
  const [error,        setError]        = useState<string | null>(null);

  const streamRef       = useRef<MediaStream | null>(null);
  const audioCtxRef     = useRef<AudioContext | null>(null);
  const analyserRef     = useRef<AnalyserNode | null>(null);
  const recorderRef     = useRef<MediaRecorder | null>(null);
  const chunksRef       = useRef<Blob[]>([]);
  const maxTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const rafRef          = useRef<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const porcupineRef    = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wvpRef          = useRef<any>(null);
  const recordingRef    = useRef(false);

  const isEnabled      = settings?.enabled ?? false;
  const hasPorcupine   = isEnabled && !!settings?.porcupineAccessKey && !!settings?.hasPorcupineModel;
  const whisperMode    = settings?.whisperMode ?? 'local';

  // ── Cleanup helpers ────────────────────────────────────────────────────────

  const stopRecorder = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    if (recorderRef.current?.state === 'recording') {
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
    recordingRef.current = false;
  }, []);

  const releaseStream = useCallback(() => {
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // ── Transcribe a blob ──────────────────────────────────────────────────────

  const transcribeBlob = useCallback(async (blob: Blob, model = 'small') => {
    setState('transcribing');
    try {
      const fd = new FormData();
      fd.append('audio', blob, 'voice.webm');
      fd.append('provider', whisperMode);
      fd.append('model', model);
      const res = await fetch(`${SERVER_BASE}/api/voice/transcribe`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(90_000),
      });
      const data = await res.json() as { text?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      const text = (data.text ?? '').trim();
      if (text) {
        setPendingText(text);
        setState('pending');
      } else {
        setState(hasPorcupine ? 'wake-listening' : 'idle');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur transcription');
      setState(hasPorcupine ? 'wake-listening' : 'idle');
    }
  }, [whisperMode, hasPorcupine]);

  // ── Start full recording after wake word ───────────────────────────────────

  const startRecording = useCallback(async (existingStream?: MediaStream) => {
    if (recordingRef.current) return;
    recordingRef.current = true;
    setError(null);

    try {
      const stream = existingStream ?? await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const audioCtx  = new AudioContext();
      const analyser  = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      const recorder = new MediaRecorder(stream, { mimeType: getSupportedMime() });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: getSupportedMime() });
        chunksRef.current = [];
        if (!existingStream) releaseStream();
        await transcribeBlob(blob, 'small');
      };

      recorder.start(100);
      setState('recording');
      silenceStartRef.current = null;

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!recordingRef.current || recorder.state !== 'recording') return;
        analyser.getByteTimeDomainData(buf);
        const rms = computeRms(buf);
        if (rms < SILENCE_THRESHOLD_RMS) {
          silenceStartRef.current ??= Date.now();
          if (Date.now() - silenceStartRef.current >= SILENCE_DURATION_MS) {
            stopRecorder();
            return;
          }
        } else {
          silenceStartRef.current = null;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      maxTimerRef.current = setTimeout(() => stopRecorder(), MAX_RECORDING_MS);

    } catch (e) {
      recordingRef.current = false;
      setError(e instanceof Error ? e.message : 'Micro inaccessible');
      setState(hasPorcupine ? 'wake-listening' : 'idle');
    }
  }, [hasPorcupine, releaseStream, stopRecorder, transcribeBlob]);

  // ── Push-to-talk / manual trigger ─────────────────────────────────────────

  const triggerManual = useCallback(() => {
    if (!isEnabled) return;
    if (state === 'idle' || state === 'wake-listening') {
      // Stop Porcupine first to avoid mic conflict
      if (wvpRef.current && porcupineRef.current) {
        wvpRef.current.unsubscribe(porcupineRef.current).catch(() => {});
      }
      void startRecording();
    }
  }, [isEnabled, state, startRecording]);

  // ── Porcupine wake-word (optional, lazy-loaded) ───────────────────────────

  useEffect(() => {
    if (!hasPorcupine) return;
    let cancelled = false;

    (async () => {
      try {
        const [{ PorcupineWorker }, { WebVoiceProcessor }] = await Promise.all([
          import('@picovoice/porcupine-web'),
          import('@picovoice/web-voice-processor'),
        ]);
        const res = await fetch(`${SERVER_BASE}/api/voice/porcupine-model`);
        if (!res.ok) throw new Error('Modèle Porcupine introuvable sur le serveur');
        const { model_base64 } = await res.json() as { model_base64: string };
        if (cancelled) return;

        const porcupine = await PorcupineWorker.create(
          settings!.porcupineAccessKey!,
          [{ base64: model_base64, label: 'hey-docteur', sensitivity: 0.65 }],
          () => {
            if (cancelled || recordingRef.current) return;
            // Stop Porcupine before opening MediaRecorder (mic conflict)
            WebVoiceProcessor.unsubscribe(porcupine).catch(() => {});
            void startRecording();
          },
          { publicPath: '/' }, // default English Porcupine model
        );

        porcupineRef.current = porcupine;
        wvpRef.current       = WebVoiceProcessor;
        await WebVoiceProcessor.subscribe(porcupine);

        if (!cancelled) setState('wake-listening');
      } catch (e) {
        if (!cancelled) {
          setError(`Wake word: ${e instanceof Error ? e.message : 'erreur Porcupine'}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (wvpRef.current && porcupineRef.current) {
        wvpRef.current.unsubscribe(porcupineRef.current).catch(() => {});
        porcupineRef.current.terminate();
      }
      porcupineRef.current = null;
      wvpRef.current       = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPorcupine, settings?.porcupineAccessKey, settings?.hasPorcupineModel]);

  // ── Disable: clean everything up ──────────────────────────────────────────

  useEffect(() => {
    if (!isEnabled) {
      stopRecorder();
      releaseStream();
      setPendingText(null);
      setError(null);
      setState('idle');
    }
  }, [isEnabled, stopRecorder, releaseStream]);

  // ── Global keyboard shortcut: Alt+M ──────────────────────────────────────

  useEffect(() => {
    if (!isEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        triggerManual();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEnabled, triggerManual]);

  // ── Confirm / cancel pending transcription ────────────────────────────────

  const confirmCommand = useCallback((text: string) => {
    if (isDestructive(text)) {
      setError('Commande refusée — les actions vocales ne peuvent pas supprimer des données');
      setPendingText(null);
      setState(hasPorcupine ? 'wake-listening' : 'idle');
      return;
    }
    setPendingText(null);
    setState(hasPorcupine ? 'wake-listening' : 'idle');
    onCommand(text);
  }, [hasPorcupine, onCommand]);

  const cancelCommand = useCallback(() => {
    setPendingText(null);
    setState(hasPorcupine ? 'wake-listening' : 'idle');
  }, [hasPorcupine]);

  return { state, pendingText, setPendingText, error, triggerManual, confirmCommand, cancelCommand };
}

function getSupportedMime(): string {
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}
