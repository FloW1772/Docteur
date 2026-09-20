import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let server, browser, assertions = 0;
const check = (condition, label) => { assert.ok(condition, label); assertions++; };
const html = '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/voice-interruption-harness.jsx").then(m=>m.mount());</script>';
try {
  server = await createServer({ configFile: false, plugins: [react()], cacheDir: '.tmp/vite-voice6', optimizeDeps: { entries: ['scripts/voice-interruption-harness.jsx'] }, server: { host: '127.0.0.1', port: 5211, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/__voice6', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1:5211/__voice6');
  await page.waitForFunction(() => window.h);
  const results = await page.evaluate(async () => {
    const checks = [];
    const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label); };
    const settle = () => new Promise(resolve => setTimeout(resolve, 15));
    const start = async () => { h.voice.triggerManual(); await settle(); };
    const cancel = async () => { h.lifecycle.cancelVoiceInteraction(); await settle(); };
    const transcript = async text => { mock.recorders.at(-1).finish(); await settle(); mock.requests.at(-1).resolve(text); await settle(); };
    const clean = () => mock.tracks.every(t => t.readyState === 'ended') && mock.contexts.every(c => c.state === 'closed') && mock.rafs.size === 0 && mock.timers.size === 0;
    const ambiguity = () => h.pipeline.runIntent({ type: 'NEEDS_CLARIFICATION', parameters: { rawText: 'ouvrir', candidates: ['cyber-audit', 'metagpt'] }, source: 'ouvrir', matchType: 'DETERMINISTIC' });
    const { VOICE_INTENTS } = await import('/src/lib/voiceIntentRegistry.ts');
    const confirmableNavigation = () => {
      // Test-only policy fixture: require confirmation for an existing LEVEL_0 action.
      VOICE_INTENTS.OPEN_FEATURE.requiresConfirmation = true;
      h.pipeline.runIntent({ type: 'OPEN_FEATURE', parameters: { featureId: 'cyber-audit' }, source: 'ouvre sentinel', matchType: 'DETERMINISTIC' });
      VOICE_INTENTS.OPEN_FEATURE.requiresConfirmation = false;
    };
    const remount = async () => { unmountHarness(); await settle(); mountHarness(); await settle(); };

    check(!h.lifecycle.lifecycle.transition('EXECUTING'), 'reject impossible IDLE to EXECUTING');
    const initialResponse = h.lifecycle.lifecycle.captureResponseGuard();
    check(initialResponse(), 'current response eligible for auto-read');
    await cancel(); check(!initialResponse(), 'STOP invalidates deferred response auto-read');
    const replacedResponse = h.lifecycle.lifecycle.captureResponseGuard();
    await start(); check(!replacedResponse(), 'new capture invalidates old response auto-read');
    await cancel();
    await start(); const idA = h.lifecycle.lifecycle.sessionId;
    check(h.lifecycle.state === 'LISTENING', 'global listening state');
    await cancel();
    check(mock.requests.length === 0 && clean(), 'STOP listening: no transcription, full cleanup');
    await start();
    const oldRecordingTimer = [...mock.timers.values()].find(t => t.delay === 30000).fn;
    await cancel(); await start(); oldRecordingTimer(); await settle();
    check(h.voice.state === 'recording' && mock.requests.length === 0, 'queued old recording timeout cannot stop new capture');
    check(!h.lifecycle.lifecycle.transition('ERROR', idA), 'stale state transition ignored');
    mock.recorders.at(-1).finish(); await settle();
    const requestA = mock.requests.at(-1);
    check(h.lifecycle.state === 'TRANSCRIBING', 'global transcribing state');
    await cancel();
    check(requestA.signal.aborted && clean(), 'STOP transcribing: abort and deadline cleanup');
    await start(); mock.recorders.at(-1).finish(); await settle();
    const requestB = mock.requests.at(-1);
    requestA.resolve('ouvre sentinel'); await settle();
    check(h.voice.state === 'transcribing' && mock.actions.length === 0 && mock.utterances.length === 0, 'late A cannot replace B, execute or speak');
    await cancel();
    check(requestB.signal.aborted, 'old finally cannot clear B controller');
    requestB.resolve('obsolete'); await settle();
    await start(); await transcript('ancienne dictée'); const oldTranscriptConfirm = h.voice.confirmCommand;
    await cancel(); await start(); await transcript('nouvelle dictée');
    oldTranscriptConfirm('ancienne dictée'); await settle();
    check(h.voice.pendingText === 'nouvelle dictée' && mock.dictated.length === 0, 'old transcript review callback cannot consume new session');
    await cancel();

    h.pipeline.setMode('DICTATION'); await settle(); await start();
    h.pipeline.setMode('COMMAND'); h.setTarget('B'); await settle();
    await transcript('ouvre sentinel');
    h.voice.confirmCommand(h.voice.pendingText); h.voice.confirmCommand(h.voice.pendingText); await settle();
    check(mock.dictated.at(-1) === 'ouvre sentinel' && mock.actions.length === 0, 'mode bound at capture start, double dictation ignored');
    await start(); h.setTarget('C'); h.pipeline.setMode('DICTATION'); await settle();
    await transcript('ouvre sentinel');
    h.voice.confirmCommand(h.voice.pendingText); h.voice.confirmCommand(h.voice.pendingText); await settle();
    check(mock.actions.length === 1 && mock.actions[0].target === 'B', 'one command with start-time mode and target');

    h.pipeline.setMode('COMMAND'); await settle();
    await start(); const oldSession = h.lifecycle.lifecycle.sessionId; await cancel(); await start();
    h.pipeline.handleTranscript('ouvre sentinel', oldSession);
    check(mock.actions.length === 1, 'late intent callback ignored');
    await cancel();
    const token = h.lifecycle.lifecycle.sessionId;
    h.pipeline.handleTranscript('ouvre sentinel', token); h.pipeline.handleTranscript('ouvre sentinel', token); await settle();
    check(mock.actions.length === 2, 'duplicate transcript token executes once');

    ambiguity(); await settle();
    const pending = h.pipeline.pendingConfirmation;
    check(!!pending && h.lifecycle.state === 'CONFIRMING', 'confirmation visible in lifecycle');
    // Instrument allowed executor outcome to count the dispatch itself, including StrictMode.
    const before = mock.actions.length;
    h.pipeline.confirmPending(); h.pipeline.confirmPending(); await settle();
    check(!h.pipeline.pendingConfirmation && mock.actions.length === before, 'double clarification confirm consumes once without privileged action');
    for (const word of ['STOP', 'ARRÊTE', 'ANNULER', 'STOPPE']) {
      ambiguity(); await settle(); h.pipeline.handleTranscript(word); await settle();
      check(!h.pipeline.pendingConfirmation && h.lifecycle.state === 'IDLE', `priority ${word} clears confirmation`);
      const count = mock.actions.length; h.pipeline.confirmPending(); await settle();
      check(mock.actions.length === count, `confirmation after ${word} refused`);
    }
    ambiguity(); await settle();
    const timer = [...mock.timers.values()].find(t => t.delay === 20000);
    timer.fn(); h.pipeline.confirmPending(); await settle();
    check(!h.pipeline.pendingConfirmation && h.pipeline.feedback.action.message.includes('expir'), 'expiry wins atomically');
    ambiguity(); await settle();
    const expiredCallback = [...mock.timers.values()].find(t => t.delay === 20000).fn;
    h.pipeline.confirmPending(); const message = h.pipeline.feedback?.action?.message; await settle();
    const confirmedMessage = h.pipeline.feedback.action.message;
    expiredCallback(); await settle();
    check(h.pipeline.feedback.action.message === confirmedMessage && !h.pipeline.pendingConfirmation, 'confirm wins, old expiry cannot overwrite');
    confirmableNavigation(); await settle(); const beforeConfirm = mock.actions.length;
    h.pipeline.confirmPending(); h.pipeline.confirmPending(); h.pipeline.handleTranscript('je confirme'); await settle();
    check(mock.actions.length === beforeConfirm + 1, 'double click plus spoken confirm dispatch exactly one action under StrictMode');
    confirmableNavigation(); await settle(); const raceCount = mock.actions.length;
    const raceTimer = [...mock.timers.values()].find(t => t.delay === 20000).fn;
    raceTimer(); h.pipeline.confirmPending(); await settle();
    check(mock.actions.length === raceCount, 'expired navigation executes zero handlers');
    confirmableNavigation(); await settle(); const oldRaceTimer = [...mock.timers.values()].find(t => t.delay === 20000).fn;
    h.pipeline.confirmPending(); oldRaceTimer(); await settle();
    check(mock.actions.length === raceCount + 1 && !h.pipeline.feedback.action.message.includes('expir'), 'confirmed navigation executes once and cannot expire');
    confirmableNavigation(); await settle(); const boundaryCount = mock.actions.length;
    const realNow = Date.now;
    Date.now = () => h.pipeline.pendingConfirmation.expiresAt;
    h.pipeline.confirmPending(); Date.now = realNow; await settle();
    check(mock.actions.length === boundaryCount && h.pipeline.feedback.action.message.includes('expir'), 'exact expiry boundary refuses execution');
    confirmableNavigation(); await settle(); const replacementExpiry = [...mock.timers.values()].find(t => t.delay === 20000).fn;
    confirmableNavigation(); await settle(); const replacementId = h.pipeline.pendingConfirmation.id;
    replacementExpiry(); await settle();
    check(h.pipeline.pendingConfirmation.id === replacementId, 'old confirmation timer cannot expire its replacement');
    await cancel();
    confirmableNavigation(); await settle(); const oldConfirm = h.pipeline.confirmPending, oldSpokenConfirm = h.pipeline.handleTranscript;
    confirmableNavigation(); await settle(); const newConfirmId = h.pipeline.pendingConfirmation.id, countBeforeOldConfirm = mock.actions.length;
    oldConfirm(); await settle();
    check(h.pipeline.pendingConfirmation.id === newConfirmId && mock.actions.length === countBeforeOldConfirm, 'stale button cannot confirm replacement target');
    oldSpokenConfirm('je confirme'); await settle();
    check(h.pipeline.pendingConfirmation.id === newConfirmId && mock.actions.length === countBeforeOldConfirm, 'stale spoken confirmation cannot confirm replacement target');
    await cancel();

    h.output.speakText('bonjour'); await settle();
    const utterance = mock.utterances.at(-1), lateEnd = utterance.onend, lateError = utterance.onerror, lateStart = utterance.onstart;
    await start();
    check(h.output.state === 'CANCELLED' && h.voice.state === 'recording' && mock.micDuringSpeech === 0, 'manual barge-in cancels before opening mic');
    h.output.speakText('nouvelle lecture'); await settle();
    lateEnd(); lateError({ error: 'error' }); lateStart(); await settle();
    check(h.output.state === 'SPEAKING' && h.lifecycle.state === 'SPEAKING', 'stale TTS callbacks cannot change new playback');
    const staleRecorder = mock.recorders.at(-1), actionCount = mock.actions.length;
    // Synthetic speaker signal + previously live microphone + hostile late transcript.
    staleRecorder.ondataavailable?.({ data: new Blob([new Uint8Array(512).fill(190)]) }); staleRecorder.onstop?.();
    for (const text of ['ouvre sentinel', 'cherche test', 'je confirme', 'STOP']) h.pipeline.handleTranscript(text);
    await settle();
    check(mock.actions.length === actionCount && h.output.state === 'SPEAKING' && mock.tracks.every(t => t.readyState === 'ended'), 'TTS-only signal creates zero commands including STOP/CONFIRM');
    await cancel(); check(clean() && h.output.state === 'CANCELLED', 'STOP speaking cleans all owners');

    for (let i = 0; i < 10; i++) { await start(); await cancel(); h.output.speakText('test'); await cancel(); }
    check(clean(), '10 mic and TTS cycles leave no resources');
    for (let i = 0; i < 10; i++) { h.output.speakText('test'); await settle(); await start(); }
    await cancel(); check(clean() && mock.micDuringSpeech === 0, '10 repeated manual barge-ins never overlap');
    mock.permissionPending = true; h.voice.triggerManual(); await settle(); await cancel(); mock.resolvePermission(); await settle(); mock.permissionPending = false;
    check(clean() && h.voice.state === 'idle', 'cancel pending permission releases late stream');

    mock.failMic = true; await start();
    check(h.lifecycle.state === 'ERROR' && !h.voice.error.includes('secret'), 'mic error sanitized');
    mock.failMic = false; await start(); await cancel(); check(clean(), 'mic error recoverable');
    mock.failTts = true; h.output.speakText('test'); await settle(); check(h.lifecycle.state === 'ERROR', 'TTS exception becomes error');
    mock.failTts = false; h.output.speakText('test'); await cancel(); check(clean(), 'TTS error recoverable');
    mock.failIntent = true; h.pipeline.handleTranscript('ouvre sentinel'); await settle();
    check(h.lifecycle.state === 'ERROR' && !h.pipeline.feedback.action.message.includes('secret'), 'intent error sanitized');
    mock.failIntent = false; h.pipeline.handleTranscript('ouvre sentinel'); await settle(); check(h.lifecycle.state === 'IDLE', 'intent error recoverable');
    await start(); mock.recorders.at(-1).finish(); await settle();
    mock.requests.at(-1).reject(Error('secret/internal/path')); await settle();
    check(h.lifecycle.state === 'ERROR' && !h.voice.error.includes('secret'), 'STT error sanitized');
    await start(); await cancel(); check(clean(), 'STT error recoverable');
    await start(); const duplicateRecorder = mock.recorders.at(-1), duplicateStop = duplicateRecorder.onstop;
    duplicateRecorder.finish(); await settle(); const requestCount = mock.requests.length;
    mock.requests.at(-1).resolve('bonjour'); await settle(); duplicateStop(); await settle();
    check(mock.requests.length === requestCount, 'duplicate saved MediaRecorder callback never retranscribes');
    await cancel();
    await start(); [...mock.timers.values()].find(t => t.delay === 30000).fn(); await settle();
    check(mock.tracks.every(t => t.readyState === 'ended') && mock.rafs.size === 0, 'recording deadline releases capture and RAF');
    await cancel();
    await start(); mock.recorders.at(-1).finish(); await settle(); const timeoutRequest = mock.requests.at(-1);
    [...mock.timers.values()].find(t => t.delay === 90000).fn();
    timeoutRequest.reject(new DOMException('aborted', 'AbortError')); await settle();
    check(timeoutRequest.signal.aborted && h.voice.sttErrorCode === 'STT_TIMEOUT' && clean(), 'STT timeout aborts and fully cleans');
    h.output.speakText('test'); await settle(); [...mock.timers.values()].find(t => t.delay === 120000).fn(); await settle();
    check(h.lifecycle.state === 'ERROR' && !speechSynthesis.active && clean(), 'TTS watchdog cancels and cleans');
    await cancel();
    const { transcribeAudio } = await import('/src/lib/voiceStt.ts');
    const aborted = new AbortController(); aborted.abort(); const beforeAbort = mock.requests.length;
    let abortCode;
    try { await transcribeAudio({ audio: new Blob([new Uint8Array(512)]), provider: 'local', signal: aborted.signal }); } catch (error) { abortCode = error.code; }
    check(abortCode === 'STT_CANCELLED' && mock.requests.length === beforeAbort, 'pre-aborted STT starts no request');

    await start(); const idBeforeRapid = h.lifecycle.lifecycle.sessionId;
    h.voice.triggerManual(); h.voice.triggerManual(); await settle();
    check(h.lifecycle.lifecycle.sessionId > idBeforeRapid && mock.recorders.filter(r => r.state === 'recording').length <= 1, 'same-turn rapid toggle cannot double capture');
    await cancel();

    await start(); await remount(); check(clean(), 'unmount listening cleanup');
    await start(); mock.recorders.at(-1).finish(); await settle(); const unmountedRequest = mock.requests.at(-1);
    await remount(); unmountedRequest.resolve('ouvre sentinel'); await settle();
    check(clean() && h.voice.pendingText === null && unmountedRequest.signal.aborted, 'unmount STT aborts and ignores result');
    ambiguity(); await settle(); const staleConfirm = h.pipeline.confirmPending;
    await remount(); staleConfirm(); await settle(); check(clean() && h.pipeline.feedback === null, 'unmount confirming clears timer and stale handler');
    h.output.speakText('test'); await settle(); const staleTts = mock.utterances.at(-1).onend, staleSpeak = h.output.speakText;
    await remount(); staleTts(); staleSpeak('obsolete'); await settle(); check(clean() && h.lifecycle.state === 'IDLE', 'unmount speaking detaches callbacks and watchdog, rejects old speak callback');
    await start(); await transcript('STOP'); check(h.lifecycle.state === 'IDLE' && h.voice.pendingText === null && clean(), 'STT STOP bypasses transcript review');
    check(document.querySelectorAll('.hud2-command-bar-status').length === 1, 'one primary voice status');
    check(mock.keyListeners.size === 1, 'one keyboard listener after repeated StrictMode remounts');
    const { deriveCortexState } = await import('/src/hooks/useCortexState.ts');
    for (const [voice, expected] of Object.entries({ LISTENING: 'listening', HEARING_SPEECH: 'listening', TRANSCRIBING: 'thinking', UNDERSTANDING: 'thinking', CONFIRMING: 'thinking', EXECUTING: 'generating', SPEAKING: 'generating', ERROR: 'error' })) {
      check(deriveCortexState({ cortexAvailable: true, cortexBusy: false, unifiedVoiceState: voice }) === expected, `Cortex mapping ${voice}`);
    }
    unmountHarness(); await settle();
    check(clean() && mock.keyListeners.size === 0, 'final unmount releases every owned resource and keyboard listener');
    return checks;
  });
  for (const label of results) check(true, label);
  check(errors.length === 0, `no browser errors: ${errors.join(', ')}`);
  console.log(`VOICE-6 INTERRUPTION BROWSER PASS ${assertions}/${assertions}`);
} finally { await browser?.close(); await server?.close(); }
