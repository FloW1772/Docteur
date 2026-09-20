import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVoiceLifecycle } from '../src/hooks/useVoiceLifecycle';
import { useVoiceActivation } from '../src/hooks/useVoiceActivation';
import { useVoiceOutput } from '../src/hooks/useVoiceOutput';
import { useVoiceCommandPipeline } from '../src/hooks/useVoiceCommandPipeline';
import CommandBar from '../src/components/hud/CommandBar';
import { deriveCortexState } from '../src/hooks/useCortexState';

function installMocks() {
  const mock = window.mock = { tracks: [], recorders: [], requests: [], utterances: [], actions: [], dictated: [], contexts: [], timers: new Map(), rafs: new Map(), permissionPending: false, failMic: false, failTts: false, failIntent: false, target: 'A', micDuringSpeech: 0 };
  mock.keyListeners = new Set();
  const addEvent = window.addEventListener.bind(window), removeEvent = window.removeEventListener.bind(window);
  window.addEventListener = (type, fn, ...args) => { if (type === 'keydown') mock.keyListeners.add(fn); addEvent(type, fn, ...args); };
  window.removeEventListener = (type, fn, ...args) => { if (type === 'keydown') mock.keyListeners.delete(fn); removeEvent(type, fn, ...args); };
  const realSet = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
  window.setTimeout = (fn, delay, ...args) => {
    let id;
    id = realSet(() => { mock.timers.delete(id); fn(...args); }, delay);
    // Confirmation uses expiresAt - Date.now(); a millisecond may elapse between reads.
    const ownedDelay = delay > 19000 && delay <= 20000 ? 20000 : delay;
    if ([20000, 30000, 90000, 120000].includes(ownedDelay)) mock.timers.set(id, { fn, delay: ownedDelay });
    return id;
  };
  window.clearTimeout = id => { mock.timers.delete(id); realClear(id); };
  window.requestAnimationFrame = fn => { const id = mock.rafs.size + 1; mock.rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = id => mock.rafs.delete(id);
  class Stream {
    constructor() { this.track = { readyState: 'live', stop() { this.readyState = 'ended'; } }; mock.tracks.push(this.track); }
    getTracks() { return [this.track]; }
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    async getUserMedia() {
      if (window.speechSynthesis.active) mock.micDuringSpeech++;
      if (mock.failMic) throw Error('secret/internal/path');
      const stream = new Stream();
      if (mock.permissionPending) await new Promise(resolve => { mock.resolvePermission = resolve; });
      return stream;
    },
  } });
  window.AudioContext = class {
    state = 'running';
    constructor() { mock.contexts.push(this); }
    createAnalyser() { return { fftSize: 512, frequencyBinCount: 256, getByteTimeDomainData(data) { data.fill(190); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    async close() { this.state = 'closed'; }
  };
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    state = 'inactive';
    constructor() { mock.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    finish() { this.ondataavailable?.({ data: new Blob([new Uint8Array(512)]) }); this.stop(); }
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    active: null,
    getVoices() { return []; },
    speak(utterance) { if (mock.failTts) throw Error('secret'); this.active = utterance; mock.utterances.push(utterance); utterance.onstart?.(); },
    cancel() { this.active = null; },
  } });
  window.fetch = (url, options) => new Promise((resolve, reject) => {
    // Deliberately ignore abort to exercise stale provider responses.
    mock.requests.push({ signal: options.signal, reject, resolve: text => resolve({ ok: true, json: async () => ({ text, provider: 'local' }) }) });
  });
}

function Harness() {
  const lifecycle = useVoiceLifecycle();
  const output = useVoiceOutput(lifecycle.lifecycle);
  const [target, setTarget] = useState('A');
  const actions = Object.fromEntries(['openFeature', 'openSettings', 'goHome', 'runSearchQuery', 'stopListening', 'stopSpeaking', 'cancelPendingVoiceAction', 'switchToFocus', 'switchToDashboard', 'cameraOn', 'cameraOff'].map(name => [name, value => {
    if (window.mock.failIntent) throw Error('secret/internal/path');
    window.mock.actions.push({ name, value, target });
  }]));
  const pipeline = useVoiceCommandPipeline(actions, output.speakText, lifecycle.lifecycle);
  const voice = useVoiceActivation({ settings: { enabled: true, whisperMode: 'local' }, lifecycle: lifecycle.lifecycle, onListeningStart: output.stopSpeaking,
    onCommand(text, session) { if (!pipeline.handleTranscript(text, session).consumedAsCommand) window.mock.dictated.push(text); },
  });
  useEffect(() => { window.h = { lifecycle, output, pipeline, voice, setTarget }; });
  return <CommandBar onSubmit={() => {}} cortexState={deriveCortexState({ cortexAvailable: true, cortexBusy: false, unifiedVoiceState: lifecycle.state })} voiceEnabled voiceState={voice.state} unifiedVoiceState={lifecycle.state} onVoiceClick={voice.triggerManual} onCancelVoice={lifecycle.cancelVoiceInteraction} />;
}
export function mount() {
  installMocks();
  localStorage.removeItem('docteur.voice.tts');
  const root = createRoot(document.getElementById('root'));
  window.mountHarness = () => root.render(<React.StrictMode><Harness /></React.StrictMode>);
  window.unmountHarness = () => root.render(null);
  window.mountHarness();
}
