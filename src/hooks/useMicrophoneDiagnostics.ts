import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeVoiceCaptureError,
  enumerateVoiceInputDevices,
  getStoredVoiceDeviceId,
  getVoiceAudioConstraints,
  getVoicePermission,
  isVoiceDeviceUnavailable,
  readVoiceTrackSettings,
  storeVoiceDeviceId,
  type VoiceActualSettings,
  type VoiceInputDevice,
  type VoicePermission,
} from '../lib/voiceMicrophone';
import { classifyClipping, frameMetrics, VoiceActivityDetector, byteTimeDomainToSamples, type ClippingStatus, type VoiceActivityState } from '../lib/voiceAudio';

export function useMicrophoneDiagnostics() {
  const [devices, setDevices] = useState<VoiceInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState<string | null>(() => getStoredVoiceDeviceId());
  const [permission, setPermission] = useState<VoicePermission>('unknown');
  const [actualSettings, setActualSettings] = useState<VoiceActualSettings | null>(null);
  const [rms, setRms] = useState(0);
  const [peak, setPeak] = useState(0);
  const [clippingRatio, setClippingRatio] = useState(0);
  const [clippingStatus, setClippingStatus] = useState<ClippingStatus>('NO CLIPPING DETECTED');
  const [dbfs, setDbfs] = useState(-Infinity);
  const [noiseFloor, setNoiseFloor] = useState<number | null>(null);
  const [vadState, setVadState] = useState<VoiceActivityState>('SILENCE');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const operationRef = useRef(0);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const observedSamplesRef = useRef(0);
  const clippedSamplesRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [nextDevices, nextPermission] = await Promise.all([
        enumerateVoiceInputDevices(),
        getVoicePermission(),
      ]);
      setDevices(nextDevices);
      setPermission(nextPermission);
      const stored = getStoredVoiceDeviceId();
      if (stored && !nextDevices.some(device => device.deviceId === stored)) {
        storeVoiceDeviceId(null);
        setSelectedDeviceIdState(null);
      }
      return nextDevices;
    } catch (cause) {
      setError(describeVoiceCaptureError(cause));
      return [];
    }
  }, []);

  const stopTest = useCallback(() => {
    operationRef.current += 1;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    analyserRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    vadRef.current = null;
    setTesting(false);
    setRms(0);
  }, []);

  const startTest = useCallback(async () => {
    if (testing) return;
    const operation = ++operationRef.current;
    setError(null);
    setActualSettings(null);
    setRms(0);
    setPeak(0);
    setClippingRatio(0);
    setClippingStatus('NO CLIPPING DETECTED');
    setDbfs(-Infinity);
    setNoiseFloor(null);
    setVadState('SILENCE');
    vadRef.current = new VoiceActivityDetector();
    observedSamplesRef.current = 0;
    clippedSamplesRef.current = 0;
    setTesting(true);

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(getVoiceAudioConstraints(selectedDeviceId));
      } catch (cause) {
        if (!selectedDeviceId || !isVoiceDeviceUnavailable(cause)) throw cause;
        storeVoiceDeviceId(null);
        setSelectedDeviceIdState(null);
        setError('Le microphone sélectionné n’est plus disponible. Utilisation du microphone par défaut.');
        stream = await navigator.mediaDevices.getUserMedia(getVoiceAudioConstraints(null));
      }
      if (operation !== operationRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      if (track) setActualSettings(readVoiceTrackSettings(track));

      const context = new AudioContext();
      audioContextRef.current = context;
      if (context.state === 'suspended') await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      const buffer = new Uint8Array(analyser.fftSize);
      let lastPublished = -Infinity;
      let peak = 0;
      const tick = () => {
        if (operation !== operationRef.current || !streamRef.current || !analyserRef.current) return;
        analyser.getByteTimeDomainData(buffer);
        const metrics = frameMetrics(byteTimeDomainToSamples(buffer));
        observedSamplesRef.current += buffer.length;
        clippedSamplesRef.current += Math.round(metrics.clippingRatio * buffer.length);
        peak = Math.max(peak, metrics.peak);
        const totalClippingRatio = clippedSamplesRef.current / observedSamplesRef.current;
        const now = performance.now();
        const vadResult = vadRef.current?.process(metrics.rms, now);
        // Process every frame; publish diagnostic UI at most ten times per second.
        if (now - lastPublished >= 100) {
        lastPublished = now;
        setRms(metrics.rms);
        setPeak(peak);
        setClippingRatio(totalClippingRatio);
        setClippingStatus(classifyClipping(totalClippingRatio));
        setDbfs(metrics.dbfs);
        if (vadResult) {
          setNoiseFloor(vadResult.noiseFloor);
          setVadState(vadResult.state);
        }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setPermission('granted');
      await refresh();
    } catch (cause) {
      if (operation === operationRef.current) {
        stopTest();
        setError(describeVoiceCaptureError(cause));
        setPermission(await getVoicePermission());
      }
    }
  }, [refresh, selectedDeviceId, stopTest, testing]);

  const selectDevice = useCallback((deviceId: string) => {
    const next = deviceId || null;
    storeVoiceDeviceId(next);
    setSelectedDeviceIdState(next);
  }, []);

  useEffect(() => {
    void refresh();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      void refresh().then(nextDevices => {
        if (selectedDeviceId && !nextDevices.some(device => device.deviceId === selectedDeviceId)) {
          stopTest();
          setError('Le microphone sélectionné n’est plus disponible. Utilisation du microphone par défaut.');
        }
      });
    };
    mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [refresh, selectedDeviceId, stopTest]);

  useEffect(() => () => stopTest(), [stopTest]);

  return {
    devices,
    selectedDeviceId,
    selectDevice,
    permission,
    actualSettings,
    rms,
    peak,
    clippingRatio,
    clippingStatus,
    dbfs,
    noiseFloor,
    vadState,
    testing,
    error,
    refresh,
    startTest,
    stopTest,
  };
}
