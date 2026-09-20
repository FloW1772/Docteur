import { useEffect, useRef, useSyncExternalStore } from 'react';
import { VoiceLifecycle } from '../lib/voiceLifecycle';

export function useVoiceLifecycle() {
  const ref = useRef<VoiceLifecycle>();
  if (!ref.current) ref.current = new VoiceLifecycle();
  const lifecycle = ref.current;
  const state = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot);
  useEffect(() => () => lifecycle.cancelVoiceInteraction(), [lifecycle]);
  return { lifecycle, state, cancelVoiceInteraction: lifecycle.cancelVoiceInteraction };
}
