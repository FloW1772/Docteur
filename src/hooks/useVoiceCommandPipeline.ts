import { useCallback, useEffect, useRef, useState } from 'react';
import { parseDeterministicIntent } from '../lib/voiceIntentParser';
import { authorizeVoiceIntent, createPendingConfirmation, isConfirmWord, resolvePendingConfirmation, type PendingVoiceConfirmation } from '../lib/voicePolicy';
import { executeVoiceIntent, type VoiceIntentActions, type VoiceIntentExecutionResult } from '../lib/voiceIntentExecutor';
import type { VoiceIntent } from '../lib/voiceIntent';
import { canAutoSpeak } from '../lib/voiceResponsePolicy';
import { getStoredTtsSettings } from '../lib/voiceTts';

export type VoiceMicMode = 'DICTATION' | 'COMMAND';

export interface VoiceCommandFeedback {
  heard: string;
  intent: VoiceIntent;
  action: VoiceIntentExecutionResult | null;
  needsConfirmation: boolean;
}

import { VoiceLifecycle } from '../lib/voiceLifecycle';
import { isEmergencyVoiceStop } from '../lib/voiceIntentParser';

export function useVoiceCommandPipeline(actions: VoiceIntentActions, speakText?: (text: string) => void, lifecycle?: VoiceLifecycle) {
  const localLifecycle = useRef(new VoiceLifecycle());
  const coordinator = lifecycle ?? localLifecycle.current;
  const [mode, setMode] = useState<VoiceMicMode>('DICTATION');
  const [feedback, setFeedback] = useState<VoiceCommandFeedback | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingVoiceConfirmation | null>(null);
  const pendingRef = useRef<{ confirmation: PendingVoiceConfirmation; actions: VoiceIntentActions } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const confirmationId = useRef(0);
  const consumedSession = useRef<number | null>(null);

  // Consume synchronously, before effects or handlers. React updaters remain pure.
  const takePending = useCallback(() => {
    const current = pendingRef.current;
    pendingRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (mounted.current) setPendingConfirmation(null);
    return current;
  }, []);

  const finishPending = useCallback((message: string) => {
    takePending();
    if (!mounted.current) return;
    setFeedback(previous => previous && { ...previous, action: { ok: false, message }, needsConfirmation: false });
    if (coordinator.getSnapshot() === 'CONFIRMING') coordinator.transition('IDLE');
  }, [takePending, coordinator]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = coordinator.onInterrupt(reason => {
      if (reason !== 'capture') finishPending('Commande annulée.');
    });
    return () => { mounted.current = false; unsubscribe(); takePending(); };
  }, [coordinator, finishPending, takePending]);

  const speakFeedback = useCallback((message: string) => {
    if (mounted.current && speakText && getStoredTtsSettings().autoSpeak && canAutoSpeak(message)) speakText(message);
  }, [speakText]);

  const execute = useCallback((intent: VoiceIntent, boundActions: VoiceIntentActions, heard = intent.source) => {
    if (!coordinator.transition('EXECUTING')) return;
    let result: VoiceIntentExecutionResult;
    try { result = executeVoiceIntent(intent, boundActions); }
    catch { result = { ok: false, message: 'La commande vocale a échoué. Réessayez.' }; }
    const next = { heard, intent, action: result, needsConfirmation: false };
    if (!mounted.current) return next;
    setFeedback(next);
    coordinator.transition(result.ok ? 'IDLE' : 'ERROR');
    speakFeedback(result.message);
    return next;
  }, [coordinator, speakFeedback]);

  const runIntent = useCallback((intent: VoiceIntent): VoiceCommandFeedback | undefined => {
    if (!mounted.current || coordinator.getSnapshot() === 'SPEAKING') return;
    takePending();
    if (coordinator.getSnapshot() === 'ERROR') coordinator.transition('IDLE');
    if (!coordinator.transition('UNDERSTANDING')) return;
    const decision = authorizeVoiceIntent(intent);
    if (decision.decision === 'DENY') {
      const next = { heard: intent.source, intent, action: { ok: false, message: decision.reason }, needsConfirmation: false };
      setFeedback(next);
      coordinator.transition('IDLE');
      speakFeedback(next.action.message);
      return next;
    }
    if (decision.decision === 'CONFIRM') {
      const pending = createPendingConfirmation(intent, String(++confirmationId.current));
      pendingRef.current = { confirmation: pending, actions };
      setPendingConfirmation(pending);
      timerRef.current = setTimeout(() => {
        if (pendingRef.current?.confirmation.id === pending.id) finishPending('Cette confirmation a expiré.');
      }, Math.max(0, pending.expiresAt - Date.now()));
      const next = { heard: intent.source, intent, action: null, needsConfirmation: true };
      setFeedback(next);
      coordinator.transition('CONFIRMING');
      // Keep the confirmation visible and microphone available; no automatic prompt TTS.
      return next;
    }
    return execute(intent, actions);
  }, [actions, coordinator, execute, finishPending, speakFeedback, takePending]);

  const resolveConfirmation = useCallback((reply: string) => {
    const pending = pendingRef.current;
    if (!mounted.current || !pending) return false;
    const outcome = resolvePendingConfirmation(pending.confirmation, reply);
    if (outcome.status === 'NOT_A_CONFIRMATION_WORD') return false;
    takePending();
    if (outcome.status === 'CONFIRMED') execute(outcome.intent, pending.actions, reply);
    else finishPending(outcome.status === 'EXPIRED' ? 'Cette confirmation a expiré.' : 'Commande annulée.');
    return true;
  }, [execute, finishPending, takePending]);

  // This callback is bound by capture at session start: mode and action context cannot drift.
  const handleTranscript = useCallback((text: string, sessionId?: number): { consumedAsCommand: boolean } => {
    if (!mounted.current || coordinator.getSnapshot() === 'SPEAKING') return { consumedAsCommand: true };
    if (sessionId !== undefined) {
      if (!coordinator.isCurrent(sessionId) || consumedSession.current === sessionId) return { consumedAsCommand: true };
      consumedSession.current = sessionId;
    }
    if (isEmergencyVoiceStop(text)) {
      coordinator.cancelVoiceInteraction();
      actions.stopListening();
      actions.stopSpeaking();
      actions.cancelPendingVoiceAction();
      return { consumedAsCommand: true };
    }
    if (mode !== 'COMMAND') return { consumedAsCommand: false };
    if (isConfirmWord(text) && pendingConfirmation?.id !== pendingRef.current?.confirmation.id) return { consumedAsCommand: true };
    if (!resolveConfirmation(text)) runIntent(parseDeterministicIntent(text));
    return { consumedAsCommand: true };
  }, [actions, coordinator, mode, pendingConfirmation?.id, resolveConfirmation, runIntent]);

  const cancelPending = coordinator.cancelVoiceInteraction;
  const confirmPending = useCallback(() => {
    if (pendingConfirmation && pendingRef.current?.confirmation.id === pendingConfirmation.id && coordinator.getSnapshot() !== 'SPEAKING') resolveConfirmation('je confirme');
  }, [coordinator, pendingConfirmation, resolveConfirmation]);
  return { mode, setMode, feedback, pendingConfirmation, handleTranscript, cancelPending, confirmPending, runIntent };
}
