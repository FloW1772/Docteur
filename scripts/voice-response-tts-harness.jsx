// Minimal harness exercising the REAL VOICE-4.1 wiring contract (the same
// maybeAutoSpeak/manualReadAloud pattern SearchConsole.tsx uses), against
// the REAL VoiceOutput class and the REAL voiceResponsePolicy gate — not a
// reimplementation. Mounted directly by the test script via page.evaluate
// imports; no React render needed since this is pure logic, but kept as a
// .jsx harness file for consistency with the other voice test scripts.
import { VoiceOutput } from '../src/lib/voiceTts';
import { canAutoSpeak, canManuallySpeak } from '../src/lib/voiceResponsePolicy';

export function createConsoleLikeController({ autoSpeakEnabled, isListeningActive }) {
  const output = new VoiceOutput();
  const speakCalls = [];
  const states = [];
  output.subscribe(state => states.push(state));

  const settings = { enabled: true, autoSpeak: autoSpeakEnabled, voiceName: '', language: 'fr-FR', rate: 1, volume: 1 };
  const autoSpokenEntryIds = new Set();

  function maybeAutoSpeak(entryId, text) {
    if (autoSpokenEntryIds.has(entryId)) return;
    if (!settings.autoSpeak) return;
    if (isListeningActive) return;
    if (!canAutoSpeak(text)) return;
    autoSpokenEntryIds.add(entryId);
    speakCalls.push(text);
    output.speakText(text, settings);
  }

  function manualReadAloud(text) {
    if (!canManuallySpeak(text)) return;
    speakCalls.push(text);
    output.speakText(text, settings);
  }

  return { output, speakCalls, states, maybeAutoSpeak, manualReadAloud };
}

export function mount() {
  document.getElementById('root').textContent = 'voice-response-tts harness ready';
}
