import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server;
try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { watch: null, host: '127.0.0.1', port: 5207, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/__voice_lifecycle_test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__voice_lifecycle_test`);
  const results = await page.evaluate(async () => {
    const { transcribeAudio, SttError } = await import('/src/lib/voiceStt.ts');
    const { VoiceOutput } = await import('/src/lib/voiceTts.ts');
    let requests = 0;
    let resolveFetch;
    window.fetch = async (input, options) => {
      requests += 1;
      if (String(input) === '/empty') return { ok: true, json: async () => ({ text: '', provider: 'local', mode: 'LOCAL' }) };
      return new Promise((resolve, reject) => {
        resolveFetch = resolve;
        options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    };

    const controller = new AbortController();
    const cancelled = transcribeAudio({ audio: new Blob([new Uint8Array(512)]), provider: 'local', signal: controller.signal });
    controller.abort();
    let cancelCode = '';
    try { await cancelled; } catch (error) { cancelCode = error instanceof SttError ? error.code : ''; }
    const empty = await transcribeAudio({ audio: new Blob([new Uint8Array(512)]), provider: 'local', endpoint: '/empty' }).catch(error => error);
    const emptyText = empty.text;

    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      active: null,
      voices: [],
      getVoices() { return this.voices; },
      speak(utterance) { this.active = utterance; utterance.onstart?.(); },
      cancel() { const current = this.active; this.active = null; current?.onerror?.({ error: 'canceled' }); },
      addEventListener() {},
      removeEventListener() {},
    } });
    const output = new VoiceOutput();
    const states = [];
    output.subscribe(state => states.push(state));
    output.speakText('test', { enabled: true, autoSpeak: false, voiceName: '', language: 'fr-FR', rate: 1, volume: 1 });
    output.stopSpeaking();
    output.stopSpeaking();
    return { requests, cancelCode, emptyText, ttsCancelled: output.state === 'CANCELLED', states };
  });

  assert.equal(results.requests, 2);
  assert.equal(results.cancelCode, 'STT_CANCELLED');
  assert.equal(results.emptyText, '');
  assert.equal(results.ttsCancelled, true);
  assert.ok(results.states.includes('QUEUED'));
  assert.ok(results.states.includes('SPEAKING'));
  assert.ok(results.states.includes('CANCELLED'));
  console.log('VOICE LIFECYCLE PASS: explicit STT provider, cancellation, deterministic TTS stop, repeated stop, no cloud fallback');
} finally {
  await browser?.close();
  await server?.close();
}