import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useMicrophoneDiagnostics } from '../src/hooks/useMicrophoneDiagnostics';

export function installMocks() {
  const state = { constraints: [], activeTracks: [], closedContexts: 0, fetches: 0, failSelected: false, deviceListeners: new Set(), deviceList: [
    { kind: 'audioinput', deviceId: 'default', label: 'Default Mic', groupId: 'group-default' },
    { kind: 'audioinput', deviceId: 'usb-mic', label: 'USB Mic', groupId: 'group-usb' },
  ] };
  class FakeTrack {
    kind = 'audio';
    readyState = 'live';
    getSettings() {
      return { deviceId: 'usb-mic', sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    }
    stop() { this.readyState = 'ended'; }
  }
  class FakeStream {
    track = new FakeTrack();
    constructor() { state.activeTracks.push(this.track); }
    getTracks() { return [this.track]; }
    getAudioTracks() { return [this.track]; }
  }
  class FakeAudioContext {
    state = 'running';
    createAnalyser() {
      return { fftSize: 512, frequencyBinCount: 256, getByteTimeDomainData(data) { data.fill(150); } };
    }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; state.closedContexts += 1; }
  }
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  const mediaDevices = {
    enumerateDevices: async () => state.deviceList,
    getUserMedia: async constraints => {
      state.constraints.push(constraints);
      if (state.failSelected && constraints.audio?.deviceId?.exact) {
        throw new DOMException('Selected device unavailable', 'OverconstrainedError');
      }
      return new FakeStream();
    },
    addEventListener(type, listener) { if (type === 'devicechange') state.deviceListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'devicechange') state.deviceListeners.delete(listener); },
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'prompt' }) } });
  const originalFetch = window.fetch;
  window.fetch = (...args) => { state.fetches += 1; return originalFetch(...args); };
  window.__voiceTest = state;
  state.emitDeviceChange = () => state.deviceListeners.forEach(listener => listener());
}

function Harness() {
  const microphone = useMicrophoneDiagnostics();
  useEffect(() => () => { window.__voiceTest.unmounted = true; }, []);
  return <div>
    <select aria-label="device" value={microphone.selectedDeviceId ?? ''} onChange={e => microphone.selectDevice(e.target.value)}>
      <option value="">Default microphone</option>
      {microphone.devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
    </select>
    <span data-testid="permission">{microphone.permission}</span>
    <span data-testid="testing">{String(microphone.testing)}</span>
    <span data-testid="rms">{microphone.rms}</span>
    <span data-testid="peak">{microphone.peak}</span>
    <span data-testid="clipping">{microphone.clippingStatus}</span>
    <span data-testid="noise-floor">{microphone.noiseFloor ?? 'calibrating'}</span>
    <span data-testid="vad">{microphone.vadState}</span>
    <button type="button" onClick={() => void microphone.startTest()}>Start test</button>
    <button type="button" onClick={microphone.stopTest}>Stop test</button>
  </div>;
}

export function mount() {
  installMocks();
  const root = createRoot(document.getElementById('root'));
  window.__unmountMicrophone = () => root.render(null);
  window.__remountMicrophone = () => root.render(<Harness />);
  window.__remountMicrophone();
}
