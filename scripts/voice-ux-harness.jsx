import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import SettingsModal from '../src/components/modals/SettingsModal';
import CommandBar from '../src/components/hud/CommandBar';
import VoiceCommandFeedbackPanel from '../src/components/hud/VoiceCommandFeedbackPanel';
import ReadAloudButton from '../src/components/console/ReadAloudButton';
import { useVoiceCommandPipeline } from '../src/hooks/useVoiceCommandPipeline';
import { useVoiceLifecycle } from '../src/hooks/useVoiceLifecycle';
import { useVoiceOutput } from '../src/hooks/useVoiceOutput';
import { cortexClient } from '../src/lib/cortex/client';
import { installMocks } from './voice-microphone-harness';

function Harness() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(window.ux.serverSettings);
  const lifecycle = useVoiceLifecycle();
  const output = useVoiceOutput(lifecycle.lifecycle);
  const actions = Object.fromEntries(['openFeature', 'openSettings', 'goHome', 'runSearchQuery', 'stopListening', 'stopSpeaking', 'cancelPendingVoiceAction', 'switchToFocus', 'switchToDashboard', 'cameraOn', 'cameraOff'].map(name => [name, () => window.ux.actions.push(name)]));
  const pipeline = useVoiceCommandPipeline(actions, output.speakText, lifecycle.lifecycle);
  const capture = ['LISTENING', 'HEARING_SPEECH'].includes(lifecycle.state) ? 'recording' : lifecycle.state === 'TRANSCRIBING' ? 'transcribing' : 'idle';
  useEffect(() => { window.h = { lifecycle, output, pipeline, setOpen, settings }; });
  const mic = () => lifecycle.lifecycle.beginCapture();
  return <>
    <main style={{ padding: 24 }}><button id="settings-trigger" onClick={() => setOpen(true)}>Réglages voix</button>
      <ReadAloudButton text="Une réponse compatible." onRead={() => output.speakText('Une réponse compatible.')} />
      <div data-testid="sensitive"><ReadAloudButton text="password=secret12345" onRead={() => output.speakText('password=secret12345')} /></div>
    </main>
    <CommandBar voiceEnabled={settings.enabled} voiceState={capture} unifiedVoiceState={lifecycle.state} onVoiceClick={mic} onCancelVoice={lifecycle.cancelVoiceInteraction} cortexState="idle" onSubmit={() => {}} voiceMode={pipeline.mode} onVoiceModeChange={pipeline.setMode} />
    {pipeline.feedback && <VoiceCommandFeedbackPanel feedback={pipeline.feedback} pendingConfirmation={pipeline.pendingConfirmation} onConfirm={pipeline.confirmPending} onCancel={pipeline.cancelPending} onRetry={mic} onSwitchToDictation={() => pipeline.setMode('DICTATION')} />}
    {open && <React.Profiler id="settings" onRender={() => window.ux.commits++}><SettingsModal initialTab="vocal" onClose={() => setOpen(false)} onVoiceSettingsChange={value => { window.ux.updates++; setSettings(value); }} onCancelVoice={lifecycle.cancelVoiceInteraction} voiceRuntime={{ state: lifecycle.state, captureState: capture, mode: pipeline.mode, ttsState: output.state, sttLatencyMs: 120 }} /></React.Profiler>}
  </>;
}

export function mount() {
  installMocks();
  window.ux = { strictLocal: true, actions: [], saves: [], updates: 0, commits: 0, voiceListeners: new Set(), failSave: false, failMic: false, serverSettings: { enabled: true, whisperMode: 'local', porcupineAccessKey: null, hasPorcupineModel: false } };
  const media = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = (...args) => window.ux.failMic ? Promise.reject(new DOMException('secret/internal', 'NotAllowedError')) : media(...args);
  const BaseContext = window.AudioContext;
  window.AudioContext = class extends BaseContext {
    createAnalyser() { let frame = 0; return { fftSize: 512, frequencyBinCount: 256, getByteTimeDomainData(data) { data.fill(140 + (++frame % 40)); } }; }
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [{ name: 'Voix locale', lang: 'fr-FR', localService: true }],
    addEventListener: (event, fn) => window.ux.voiceListeners.add(fn),
    removeEventListener: (event, fn) => window.ux.voiceListeners.delete(fn),
    speak: utterance => utterance.onstart?.(), cancel() {},
  } });
  cortexClient.routerStatus = async () => ({ settings: { strict_local_mode: window.ux.strictLocal }, statuses: [], ollama_connected: true });
  cortexClient.routerStats = async () => ({ stats: [] });
  cortexClient.getGeminiRpm = async () => 10;
  cortexClient.ollamaModels = async () => ({ connected: true, models: [] });
  cortexClient.getStyleExampleSettings = async () => ({ enabled: false });
  cortexClient.getProvidersOverview = async () => null;
  cortexClient.getPersonaSettings = async () => null;
  cortexClient.listPreferenceFacts = async () => [];
  cortexClient.getVoiceSettings = async () => ({ ...window.ux.serverSettings });
  cortexClient.updateVoiceSettings = async updates => {
    if (window.ux.failSave) throw Error('secret/internal/path');
    window.ux.saves.push(updates);
    Object.assign(window.ux.serverSettings, updates);
  };
  const root = createRoot(document.getElementById('root'));
  window.remount = () => root.render(<React.StrictMode><Harness key={Date.now()} /></React.StrictMode>);
  window.remount();
}
