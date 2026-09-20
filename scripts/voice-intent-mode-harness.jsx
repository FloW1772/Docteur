import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import CommandBar from '../src/components/hud/CommandBar';
import VoiceCommandFeedbackPanel from '../src/components/hud/VoiceCommandFeedbackPanel';
import { useVoiceCommandPipeline } from '../src/hooks/useVoiceCommandPipeline';

function Harness() {
  const [dictatedText, setDictatedText] = useState('');
  const [openedFeature, setOpenedFeature] = useState('');
  const [log, setLog] = useState([]);
  const push = (label) => setLog(prev => [...prev, label]);

  const actions = {
    openFeature: (id) => { setOpenedFeature(id); push(`openFeature:${id}`); },
    openSettings: (tab) => push(`openSettings:${tab ?? ''}`),
    goHome: () => push('goHome'),
    runSearchQuery: (q) => push(`runSearchQuery:${q}`),
    stopListening: () => push('stopListening'),
    stopSpeaking: () => push('stopSpeaking'),
    cancelPendingVoiceAction: () => push('cancelPendingVoiceAction'),
    switchToFocus: () => push('switchToFocus'),
    switchToDashboard: () => push('switchToDashboard'),
    cameraOn: () => push('cameraOn'),
    cameraOff: () => push('cameraOff'),
  };

  const pipeline = useVoiceCommandPipeline(actions);

  // Mirrors App.tsx's own onCommand wiring exactly: try the pipeline
  // first, fall back to dictation (text into input) if not consumed.
  function simulateTranscript(text) {
    const { consumedAsCommand } = pipeline.handleTranscript(text);
    if (!consumedAsCommand) setDictatedText(text);
    return consumedAsCommand;
  }

  // Triggers a real NEEDS_CLARIFICATION intent — the one intent type in
  // VOICE-5's registry that legitimately resolves to CONFIRM (see
  // voicePolicy.ts's authorizeVoiceIntent) — to exercise the confirm/
  // cancel UI path even though no two real feature aliases currently
  // collide (so the parser itself never produces this from ordinary
  // speech today; this calls pipeline.runIntent directly with an
  // already-shaped intent, exactly as a future ambiguous-alias case
  // would).
  function triggerClarificationExample() {
    pipeline.runIntent({
      type: 'NEEDS_CLARIFICATION',
      parameters: { rawText: 'ouvre le truc de sécurité', candidates: ['cyber-audit', 'metagpt'] },
      matchType: 'DETERMINISTIC',
      source: 'ouvre le truc de sécurité',
    });
  }

  useEffect(() => {
    window.__voiceHarness = {
      simulateTranscript,
      setMode: pipeline.setMode,
      getMode: () => pipeline.mode,
      confirmPending: pipeline.confirmPending,
      cancelPending: pipeline.cancelPending,
      getPending: () => pipeline.pendingConfirmation,
      getFeedback: () => pipeline.feedback,
      triggerClarificationExample,
    };
  });

  return (
    <div>
      <CommandBar
        onSubmit={() => {}}
        cortexState="idle"
        voiceEnabled
        voiceState="idle"
        onVoiceClick={() => {}}
        voiceMode={pipeline.mode}
        onVoiceModeChange={pipeline.setMode}
      />
      {pipeline.feedback && (
        <VoiceCommandFeedbackPanel
          feedback={pipeline.feedback}
          pendingConfirmation={pipeline.pendingConfirmation}
          onConfirm={pipeline.confirmPending}
          onCancel={pipeline.cancelPending}
        />
      )}
      <p data-testid="dictated-text">{dictatedText}</p>
      <p data-testid="opened-feature">{openedFeature}</p>
      <p data-testid="log">{log.join(',')}</p>
      <p data-testid="mode">{pipeline.mode}</p>
      <p data-testid="feedback-intent">{pipeline.feedback?.intent.type ?? ''}</p>
      <p data-testid="needs-confirmation">{String(pipeline.feedback?.needsConfirmation ?? false)}</p>
    </div>
  );
}

export function mount() {
  createRoot(document.getElementById('root')).render(<Harness />);
}
