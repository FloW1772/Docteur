import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceLifecycle } from '../lib/voiceLifecycle';
import { getStoredTtsSettings, VoiceOutput, type TtsSettings, type TtsState } from '../lib/voiceTts';

export function useVoiceOutput(lifecycle?: VoiceLifecycle) {
  const outputRef = useRef<VoiceOutput | null>(null);
  if (!outputRef.current) outputRef.current = new VoiceOutput(lifecycle);
  const [state, setState] = useState<TtsState>('IDLE');
  const mounted = useRef(true);

  useEffect(() => {
    const output = outputRef.current!;
    return output.subscribe(setState);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; outputRef.current?.stopSpeaking(); };
  }, []);
  useEffect(() => lifecycle?.onInterrupt(() => outputRef.current!.stopSpeaking()), [lifecycle]);
  const speakText = useCallback((text: string, settings?: TtsSettings) => mounted.current && outputRef.current!.speakText(text, settings ?? getStoredTtsSettings()), []);
  const stopSpeaking = useCallback(() => outputRef.current!.stopSpeaking(), []);

  return {
    state,
    isSpeaking: state === 'SPEAKING' || state === 'QUEUED',
    speakText,
    stopSpeaking,
  };
}
