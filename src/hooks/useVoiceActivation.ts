import { useState, useEffect, useRef, useCallback } from 'react';
import type { VoiceSettings } from '../lib/cortex/client';
import { describeVoiceCaptureError, getStoredVoiceDeviceId, getVoiceAudioConstraints, isVoiceDeviceUnavailable } from '../lib/voiceMicrophone';
import { byteTimeDomainToSamples, frameMetrics, VoiceActivityDetector } from '../lib/voiceAudio';
import { SttError, transcribeAudio, type SttErrorCode, type SttProvider } from '../lib/voiceStt';
import { VoiceLifecycle } from '../lib/voiceLifecycle';
import { isEmergencyVoiceStop } from '../lib/voiceIntentParser';

export type VoiceState = 'idle' | 'wake-listening' | 'recording' | 'transcribing' | 'pending';
export type SttState = 'IDLE' | 'QUEUED' | 'TRANSCRIBING' | 'COMPLETED' | 'COMPLETED_EMPTY' | 'CANCELLED' | 'ERROR';

// Destructive commands are always blocked for voice input
const DESTRUCTIVE_WORDS = ['supprime', 'efface', 'delete', 'remove', 'vide', 'clear', 'reset', 'drop', 'destroy', 'réinitialise'];
function isDestructive(text: string): boolean {
  const lower = text.toLowerCase();
  return DESTRUCTIVE_WORDS.some(w => lower.includes(w));
}

const SILENCE_DURATION_MS    = 2000;   // 2s of silence stops the recording
const MAX_RECORDING_MS       = 30_000; // hard cap per recording

const SERVER_BASE = `${window.location.protocol}//${window.location.hostname}:3001`;

export function useVoiceActivation({
  settings,
  onCommand,
  onListeningStart,
  lifecycle,
}: {
  settings: VoiceSettings | null;
  onCommand: (text: string, sessionId?: number) => void;
  onListeningStart?: () => void;
  lifecycle?: VoiceLifecycle;
}) {
  const localLifecycle = useRef(new VoiceLifecycle());
  const coordinator = lifecycle ?? localLifecycle.current;
  const sessionRef = useRef(0);
  const commandRef = useRef(onCommand);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const sttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state,        setState]        = useState<VoiceState>('idle');
  const [pendingText,  setPendingText]  = useState<string | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [sttState,     setSttState]     = useState<SttState>('IDLE');
  const [sttErrorCode, setSttErrorCode] = useState<SttErrorCode | null>(null);
  const [sttProvider,  setSttProvider]  = useState<SttProvider>(settings?.whisperMode ?? 'local');
  const [sttLatencyMs, setSttLatencyMs] = useState<number | null>(null);

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
  const captureOperationRef = useRef(0);
  const vadRef          = useRef<VoiceActivityDetector | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const transcriptionStartedRef = useRef(false);

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
    vadRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // ── Transcribe a blob ──────────────────────────────────────────────────────

  const transcribeBlob = useCallback(async (blob: Blob, model: string, operation: number) => {
    if (operation !== captureOperationRef.current || transcriptionStartedRef.current) return;
    transcriptionStartedRef.current = true;
    const controller = new AbortController();
    transcriptionAbortRef.current = controller;
    setSttState('QUEUED');
    setSttErrorCode(null);
    setSttProvider(whisperMode);
    setState('transcribing');
    coordinator.transition('TRANSCRIBING', sessionRef.current);
    setSttState('TRANSCRIBING');
    let timedOut = false;
    const timeout = sttTimerRef.current = setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
    try {
      const result = await transcribeAudio({ audio: blob, provider: whisperMode, model, signal: controller.signal });
      if (operation !== captureOperationRef.current) return;
      setSttProvider(result.provider);
      setSttLatencyMs(result.latencyMs);
      if (result.text) {
        if (isEmergencyVoiceStop(result.text)) { coordinator.cancelVoiceInteraction(); return; }
        pendingRef.current = true;
        coordinator.transition('CONFIRMING', sessionRef.current);
        setPendingText(result.text);
        setState('pending');
        setSttState('COMPLETED');
      } else {
        coordinator.transition('IDLE', sessionRef.current);
        setSttState('COMPLETED_EMPTY');
        setError('Aucune parole détectée.');
        setState('idle');
      }
    } catch (cause) {
      if (operation !== captureOperationRef.current) return;
      const normalized = timedOut
        ? new SttError('STT_TIMEOUT', whisperMode, 'La transcription a dépassé le délai autorisé.')
        : cause instanceof SttError
        ? cause
        : new SttError('STT_PROVIDER_ERROR', whisperMode, 'Le service de transcription est indisponible.');
      coordinator.transition('ERROR', sessionRef.current);
      setSttErrorCode(normalized.code);
      setSttState(normalized.code === 'STT_CANCELLED' ? 'CANCELLED' : 'ERROR');
      setError(normalized.message);
      setState('idle');
    } finally {
      clearTimeout(timeout);
      if (operation === captureOperationRef.current) {
        sttTimerRef.current = null;
        transcriptionAbortRef.current = null;
        transcriptionStartedRef.current = false;
      }
    }
  }, [whisperMode, hasPorcupine, coordinator]);

  // ── Start full recording after wake word ───────────────────────────────────

  const startRecording = useCallback(async (existingStream?: MediaStream) => {
    if (!mountedRef.current || recordingRef.current) return;
    sessionRef.current = coordinator.beginCapture();
    commandRef.current = onCommand;
    const operation = ++captureOperationRef.current;
    recordingRef.current = true;
    setError(null);
    onListeningStart?.();

    try {
      let stream = existingStream;
      if (!stream) {
        const selectedDeviceId = getStoredVoiceDeviceId();
        try {
          stream = await navigator.mediaDevices.getUserMedia(getVoiceAudioConstraints(selectedDeviceId));
        } catch (cause) {
          if (operation !== captureOperationRef.current) return;
          if (!selectedDeviceId || !isVoiceDeviceUnavailable(cause)) throw cause;
          setError('Le microphone sélectionné n’est plus disponible. Utilisation du microphone par défaut.');
          stream = await navigator.mediaDevices.getUserMedia(getVoiceAudioConstraints(null));
        }
      }
      if (operation !== captureOperationRef.current || !recordingRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;

      const audioCtx  = new AudioContext();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (operation !== captureOperationRef.current) {
        void audioCtx.close().catch(() => {});
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const analyser  = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      const mimeType = getSupportedMime();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      chunksRef.current = chunks;
      let stopped = false;

      recorder.ondataavailable = (e) => { if (operation === captureOperationRef.current && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        if (stopped || operation !== captureOperationRef.current || transcriptionStartedRef.current) return;
        stopped = true;
        stopRecorder();
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorder.onerror = null;
        const blob = new Blob(chunks, { type: mimeType });
        chunks.length = 0;
        chunksRef.current = [];
        releaseStream();
        recorderRef.current = null;
        await transcribeBlob(blob, 'small', operation);
      };
      recorder.onerror = () => {
        if (operation !== captureOperationRef.current) return;
        coordinator.cancelVoiceInteraction();
        coordinator.transition('ERROR');
        setError('Le microphone est indisponible. Réessayez.');
      };

      recorder.start(100);
      setState('recording');
      silenceStartRef.current = null;
      vadRef.current = new VoiceActivityDetector();

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (operation !== captureOperationRef.current || !recordingRef.current || recorder.state !== 'recording') return;
        analyser.getByteTimeDomainData(buf);
        const metrics = frameMetrics(byteTimeDomainToSamples(buf));
        const vadResult = vadRef.current?.process(metrics.rms, performance.now());
        if (vadResult?.event === 'VOICE_START') coordinator.transition('HEARING_SPEECH', sessionRef.current);
        if (vadResult?.event === 'VOICE_END') {
          stopRecorder();
          return;
        }
        if (vadResult?.state === 'SILENCE') {
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
      maxTimerRef.current = setTimeout(() => {
        if (operation === captureOperationRef.current) stopRecorder();
      }, MAX_RECORDING_MS);

    } catch (e) {
      if (operation !== captureOperationRef.current) return;
      recordingRef.current = false;
      if (recorderRef.current) {
        recorderRef.current.onstop = null;
        recorderRef.current.ondataavailable = null;
        recorderRef.current.onerror = null;
      }
      stopRecorder();
      recorderRef.current = null;
      releaseStream();
      coordinator.transition('ERROR', sessionRef.current);
      setError(describeVoiceCaptureError(e));
      setState('idle');
    }
  }, [hasPorcupine, onListeningStart, onCommand, coordinator, releaseStream, stopRecorder, transcribeBlob]);

  const cleanupCapture = useCallback(() => {
    captureOperationRef.current += 1;
    pendingRef.current = false;
    if (sttTimerRef.current) clearTimeout(sttTimerRef.current);
    sttTimerRef.current = null;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    transcriptionStartedRef.current = false;
    if (recorderRef.current) {
      recorderRef.current.onstop = null;
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onerror = null;
    }
    stopRecorder();
    recorderRef.current = null;
    chunksRef.current.length = 0;
    chunksRef.current = [];
    releaseStream();
    if (wvpRef.current && porcupineRef.current) void wvpRef.current.unsubscribe(porcupineRef.current).catch(() => {});
  }, [releaseStream, stopRecorder]);

  useEffect(() => coordinator.onInterrupt(() => {
    cleanupCapture();
    setPendingText(null);
    setError(null);
    setSttState('CANCELLED');
    setState('idle');
  }), [coordinator, cleanupCapture]);
  const stopListening = coordinator.cancelVoiceInteraction;
  const startRecordingRef = useRef(startRecording);
  startRecordingRef.current = startRecording;

  // ── Push-to-talk / manual trigger ─────────────────────────────────────────

  const triggerManual = useCallback(() => {
    if (!mountedRef.current || !isEnabled) return;
    if (recordingRef.current || transcriptionAbortRef.current || state === 'recording' || state === 'transcribing') {
      stopListening();
      return;
    }
    if (state === 'idle' || state === 'wake-listening') {
      // Stop Porcupine first to avoid mic conflict
      if (wvpRef.current && porcupineRef.current) {
        wvpRef.current.unsubscribe(porcupineRef.current).catch(() => {});
      }
      void startRecording();
    }
  }, [isEnabled, state, startRecording, stopListening]);

  // ── Porcupine wake-word (optional, lazy-loaded) ───────────────────────────

  useEffect(() => {
    if (!hasPorcupine) return;
    let cancelled = false;
    const setupSession = coordinator.sessionId;

    (async () => {
      try {
        const [{ PorcupineWorker }, { WebVoiceProcessor }] = await Promise.all([
          import('@picovoice/porcupine-web'),
          import('@picovoice/web-voice-processor'),
        ]);
        const res = await fetch(`${SERVER_BASE}/api/voice/porcupine-model`);
        if (!res.ok) throw new Error('Modèle Porcupine introuvable sur le serveur');
        const { model_base64 } = await res.json() as { model_base64: string };
        if (cancelled || !coordinator.isCurrent(setupSession)) return;

        const porcupine = await PorcupineWorker.create(
          settings!.porcupineAccessKey!,
          [{ base64: model_base64, label: 'hey-docteur', sensitivity: 0.65 }],
          () => {
            if (cancelled || recordingRef.current || coordinator.getSnapshot() !== 'LISTENING') return;
            // Stop Porcupine before opening MediaRecorder (mic conflict)
            WebVoiceProcessor.unsubscribe(porcupine).catch(() => {});
            void startRecordingRef.current();
          },
          { publicPath: '/' }, // default English Porcupine model
        );

        if (cancelled || !coordinator.isCurrent(setupSession)) { porcupine.terminate(); return; }
        porcupineRef.current = porcupine;
        wvpRef.current       = WebVoiceProcessor;
        await WebVoiceProcessor.subscribe(porcupine);

        if (cancelled || coordinator.getSnapshot() === 'SPEAKING') await WebVoiceProcessor.unsubscribe(porcupine);
        else {
          setState('wake-listening');
          coordinator.transition('LISTENING', setupSession);
        }
      } catch (e) {
        if (!cancelled) {
          setError('Le mot d’activation est indisponible. Utilisez le bouton micro.');
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
      stopListening();
      setPendingText(null);
      setError(null);
      setState('idle');
    }
  }, [isEnabled, stopListening]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupCapture();
    };
  }, [cleanupCapture]);

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

  const renderedSession = sessionRef.current;
  const confirmCommand = useCallback((text: string) => {
    if (!mountedRef.current || !pendingRef.current || !coordinator.isCurrent(renderedSession)) return;
    pendingRef.current = false;
    coordinator.transition('UNDERSTANDING', sessionRef.current);
    if (isDestructive(text)) {
      coordinator.transition('IDLE', sessionRef.current);
      setError('Commande refusée — les actions vocales ne peuvent pas supprimer des données');
      setPendingText(null);
      setState('idle');
      return;
    }
    setPendingText(null);
    setState('idle');
    try {
      commandRef.current(text, sessionRef.current);
      if (coordinator.getSnapshot() === 'UNDERSTANDING') coordinator.transition('IDLE', sessionRef.current);
    } catch {
      coordinator.transition('ERROR', sessionRef.current);
      setError('La commande vocale a échoué. Réessayez.');
    }
  }, [hasPorcupine, coordinator, renderedSession]);

  const cancelCommand = coordinator.cancelVoiceInteraction;

  return { state, pendingText, setPendingText, error, sttState, sttErrorCode, sttProvider, sttLatencyMs, triggerManual, stopListening, confirmCommand, cancelCommand };
}

function getSupportedMime(): string {
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}
