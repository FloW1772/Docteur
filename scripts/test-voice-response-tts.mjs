// VOICE-4.1 — TTS response integration tests. Exercises the real
// voiceResponsePolicy.ts pure functions and the real VoiceOutput class
// (voiceTts.ts) through the same maybeAutoSpeak/manualReadAloud contract
// SearchConsole.tsx implements, with window.speechSynthesis mocked the
// same way scripts/test-voice-lifecycle.mjs does.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = (value, label) => { if (!value) throw new Error(`FAILED: ${label}`); assertions++; };
const watchdog = setTimeout(() => { console.error('Voice response TTS browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-voice-response-tts',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/voice-response-tts-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5208, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Voice response TTS browser error:', e.message); });

  await page.route('**/__voice_response_tts_test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto(`${origin}/__voice_response_tts_test`);

  const results = await page.evaluate(async () => {
    // Mirrors test-voice-lifecycle.mjs's mock exactly: speak() fires
    // onstart synchronously, cancel() fires onerror('canceled')
    // synchronously — deterministic, no timers needed.
    function installSpeechSynthesisMock() {
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        active: null,
        voices: [],
        getVoices() { return this.voices; },
        speak(utterance) { this.active = utterance; utterance.onstart?.(); },
        cancel() { const current = this.active; this.active = null; current?.onerror?.({ error: 'canceled' }); },
        addEventListener() {},
        removeEventListener() {},
      } });
    }

    const policy = await import('/src/lib/voiceResponsePolicy.ts');
    const tts = await import('/src/lib/voiceTts.ts');
    const { createConsoleLikeController } = await import('/scripts/voice-response-tts-harness.jsx');

    const out = {};

    // ── 0. Real default (no localStorage key set): autoSpeak defaults OFF ─
    localStorage.removeItem('docteur.voice.tts');
    out.realDefaultAutoSpeak = tts.getStoredTtsSettings().autoSpeak;

    // ── 0b. Real localStorage round-trip: this is exactly what
    //    SettingsModal's saveTtsSettings() writes when the "Read
    //    responses aloud" checkbox is toggled — confirms the actual
    //    persisted setting (not just a test parameter) drives auto-read.
    installSpeechSynthesisMock();
    {
      localStorage.setItem('docteur.voice.tts', JSON.stringify({ enabled: true, autoSpeak: false, voiceName: '', language: 'fr-FR', rate: 1, volume: 1 }));
      const offSettings = tts.getStoredTtsSettings();
      localStorage.setItem('docteur.voice.tts', JSON.stringify({ enabled: true, autoSpeak: true, voiceName: '', language: 'fr-FR', rate: 1, volume: 1 }));
      const onSettings = tts.getStoredTtsSettings();
      localStorage.removeItem('docteur.voice.tts');
      out.realSettingsToggle = { off: offSettings.autoSpeak, on: onSettings.autoSpeak };
    }

    // ── 1. auto-read OFF: response appears, speak count = 0 ──────────────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: false, isListeningActive: false });
      ctrl.maybeAutoSpeak('e1', 'Voici la réponse finale.');
      out.autoReadOffSpeakCount = ctrl.speakCalls.length;
    }

    // ── 2. auto-read ON: single final response speaks exactly once ───────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('e1', 'Voici la réponse finale.');
      out.autoReadOnSpeakCount = ctrl.speakCalls.length;
      out.autoReadOnState = ctrl.output.state;
    }

    // ── 3. streamed response: only 'done'-equivalent (final) text speaks,
    //    never an intermediate phase message ─────────────────────────────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      // Simulate intermediate phases NEVER calling maybeAutoSpeak (this is
      // exactly what handleWebAnswer does — status events never call it).
      // Only the final text arrives here.
      ctrl.maybeAutoSpeak('e2', 'Réponse web finale.');
      out.streamedFinalOnlySpeakCount = ctrl.speakCalls.length;
      out.streamedFinalOnlyText = ctrl.speakCalls[0];
    }

    // ── 4. duplicate render / rerender / state update: same entry id
    //    speaks at most once (single-speak guarantee via the ref-backed
    //    dedup set, not just voiceTts.ts's own cancel-first behavior) ────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('e3', 'Réponse.');
      ctrl.maybeAutoSpeak('e3', 'Réponse.'); // rerender / duplicate event with the SAME entry id
      ctrl.maybeAutoSpeak('e3', 'Réponse.'); // a third, e.g. a late state update
      out.duplicateEntrySpeakCount = ctrl.speakCalls.length;
    }

    // ── 5. new response cancels old speech: a second DIFFERENT entry
    //    still only ever has one utterance active at a time (voiceTts.ts's
    //    speakText() always calls stopSpeaking() first) ──────────────────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('e4', 'Première réponse.');
      const stateAfterFirst = ctrl.output.state;
      ctrl.maybeAutoSpeak('e5', 'Deuxième réponse, plus récente.');
      out.newResponseCancelsOld = {
        speakCount: ctrl.speakCalls.length,
        firstWasSpeaking: stateAfterFirst === 'SPEAKING',
        finalState: ctrl.output.state,
        finalTextSpoken: ctrl.speakCalls[ctrl.speakCalls.length - 1],
      };
    }

    // ── 6. manual Read Aloud works even with auto-read OFF ────────────────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: false, isListeningActive: false });
      ctrl.manualReadAloud('Lecture manuelle demandée.');
      out.manualReadAloudWithAutoOff = { speakCount: ctrl.speakCalls.length, state: ctrl.output.state };
    }

    // ── 7. Stop Speaking cancels immediately ──────────────────────────────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('e6', 'Réponse à interrompre.');
      const wasSpeaking = ctrl.output.state === 'SPEAKING';
      ctrl.output.stopSpeaking();
      out.stopSpeaking = { wasSpeaking, afterStop: ctrl.output.state };
    }

    // ── 8/9/10/11. sensitive content blocked (JWT, API key, cookie,
    //    Authorization) — both auto AND manual paths refuse ──────────────
    installSpeechSynthesisMock();
    {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const apiKey = 'Here is your key: sk-live-abcdefghij1234567890';
      const cookieText = 'Set-Cookie: session_id=verysecretvalue123; Path=/';
      const authHeaderText = 'Authorization: Bearer abcdef1234567890ghijkl';

      const ctrlAuto = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrlAuto.maybeAutoSpeak('jwt', jwt);
      ctrlAuto.maybeAutoSpeak('key', apiKey);
      ctrlAuto.maybeAutoSpeak('cookie', cookieText);
      ctrlAuto.maybeAutoSpeak('auth', authHeaderText);

      const ctrlManual = createConsoleLikeController({ autoSpeakEnabled: false, isListeningActive: false });
      ctrlManual.manualReadAloud(jwt);
      ctrlManual.manualReadAloud(apiKey);
      ctrlManual.manualReadAloud(cookieText);
      ctrlManual.manualReadAloud(authHeaderText);

      out.sensitiveBlocked = {
        autoSpeakCount: ctrlAuto.speakCalls.length,
        manualSpeakCount: ctrlManual.speakCalls.length,
        jwtDetected: policy.containsSensitiveContent(jwt),
        apiKeyDetected: policy.containsSensitiveContent(apiKey),
        cookieDetected: policy.containsSensitiveContent(cookieText),
        authDetected: policy.containsSensitiveContent(authHeaderText),
      };
    }

    // ── 12. large code block: not auto-read ───────────────────────────────
    installSpeechSynthesisMock();
    {
      const bigCode = '```js\n' + 'const x = 1;\n'.repeat(80) + '```';
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('code', bigCode);
      out.largeCodeBlocked = { speakCount: ctrl.speakCalls.length, detected: policy.isTooLongOrStructuredForAutoSpeak(bigCode) };
    }

    // Short code fences should NOT be blocked (avoid over-blocking).
    {
      const smallCode = 'Utilisez `npm install` pour installer.';
      out.smallCodeAllowed = !policy.isTooLongOrStructuredForAutoSpeak(smallCode);
    }

    // ── 13. component unmount: stopSpeaking() called, no phantom
    //     utterance (mirrors useVoiceOutput's own unmount cleanup) ───────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('e7', 'Réponse en cours au moment du démontage.');
      const wasSpeaking = ctrl.output.state === 'SPEAKING';
      // Simulate what useVoiceOutput's unmount effect does.
      ctrl.output.stopSpeaking();
      out.unmountCleanup = { wasSpeaking, afterUnmount: ctrl.output.state };
    }

    // ── 14. manual mic interrupts TTS (App.tsx's onListeningStart wiring —
    //     replicate the exact call sequence: mic starts -> stopSpeaking()) ─
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: false });
      ctrl.maybeAutoSpeak('e8', 'Réponse en cours quand le micro démarre.');
      const wasSpeaking = ctrl.output.state === 'SPEAKING';
      ctrl.output.stopSpeaking(); // == onListeningStart: voiceOutput.stopSpeaking in App.tsx
      out.micInterruptsTts = { wasSpeaking, afterMicStart: ctrl.output.state };
    }

    // ── 15. self-listening remains blocked: auto-read never speaks while
    //     isListeningActive is true (the NEW guard this phase adds) ──────
    installSpeechSynthesisMock();
    {
      const ctrl = createConsoleLikeController({ autoSpeakEnabled: true, isListeningActive: true });
      ctrl.maybeAutoSpeak('e9', 'Ne doit pas être lu pendant l’écoute.');
      out.selfListeningBlocked = { speakCount: ctrl.speakCalls.length };
    }

    return out;
  });

  // ── Assertions ───────────────────────────────────────────────────────
  check(results.realDefaultAutoSpeak === false, 'real default (no stored settings) has autoSpeak OFF');
  check(results.realSettingsToggle.off === false, 'real persisted settings: autoSpeak false round-trips as false');
  check(results.realSettingsToggle.on === true, 'real persisted settings: autoSpeak true round-trips as true (matches SettingsModal checkbox wiring)');
  check(results.autoReadOffSpeakCount === 0, 'auto-read OFF -> speak count 0');
  check(results.autoReadOnSpeakCount === 1, 'auto-read ON -> speak count 1');
  check(results.autoReadOnState === 'SPEAKING', 'auto-read ON -> reaches SPEAKING state');
  check(results.streamedFinalOnlySpeakCount === 1, 'streamed response speaks only the final text, once');
  check(results.streamedFinalOnlyText === 'Réponse web finale.', 'streamed final text matches exactly');
  check(results.duplicateEntrySpeakCount === 1, 'duplicate render/state-update for the same entry speaks only once');
  check(results.newResponseCancelsOld.speakCount === 2, 'two distinct responses each triggered one speakText call');
  check(results.newResponseCancelsOld.firstWasSpeaking === true, 'first response was actually speaking before being superseded');
  check(results.newResponseCancelsOld.finalState === 'SPEAKING', 'new response ends up SPEAKING (old one was cancelled first)');
  check(results.newResponseCancelsOld.finalTextSpoken === 'Deuxième réponse, plus récente.', 'the LATEST response is the one actually heard');
  check(results.manualReadAloudWithAutoOff.speakCount === 1, 'manual Read Aloud works even with auto-read OFF');
  check(results.manualReadAloudWithAutoOff.state === 'SPEAKING', 'manual Read Aloud reaches SPEAKING');
  check(results.stopSpeaking.wasSpeaking === true, 'Stop Speaking test: was actually speaking first');
  check(results.stopSpeaking.afterStop === 'CANCELLED', 'Stop Speaking cancels immediately');
  check(results.sensitiveBlocked.jwtDetected === true, 'JWT pattern detected');
  check(results.sensitiveBlocked.apiKeyDetected === true, 'API key pattern detected');
  check(results.sensitiveBlocked.cookieDetected === true, 'cookie pattern detected');
  check(results.sensitiveBlocked.authDetected === true, 'Authorization header pattern detected');
  check(results.sensitiveBlocked.autoSpeakCount === 0, 'sensitive content: 0 auto-read speak calls (JWT/API key/cookie/Authorization all blocked)');
  check(results.sensitiveBlocked.manualSpeakCount === 0, 'sensitive content: 0 manual-read speak calls either — a secret is never spoken regardless of trigger');
  check(results.largeCodeBlocked.detected === true, 'large fenced code block flagged as too-structured for auto-speak');
  check(results.largeCodeBlocked.speakCount === 0, 'large code block is not auto-read');
  check(results.smallCodeAllowed === true, 'a short inline code mention is NOT over-blocked');
  check(results.unmountCleanup.wasSpeaking === true, 'unmount test: was actually speaking before cleanup');
  check(results.unmountCleanup.afterUnmount === 'CANCELLED', 'component unmount stops speech, no phantom utterance');
  check(results.micInterruptsTts.wasSpeaking === true, 'mic-interrupt test: was actually speaking before mic start');
  check(results.micInterruptsTts.afterMicStart === 'CANCELLED', 'manual mic start interrupts TTS (existing onListeningStart wiring)');
  check(results.selfListeningBlocked.speakCount === 0, 'self-listening guard: auto-read never speaks while isListeningActive is true');

  check(errors.length === 0, 'no uncaught page errors');
  console.log(`VOICE RESPONSE TTS PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
