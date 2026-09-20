import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server;
try {
  server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { watch: null, host: '127.0.0.1', port: 5206, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/__voice_audio_test', route => route.fulfill({
    contentType: 'text/html',
    body: '<div id="root"></div>',
  }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__voice_audio_test`);
  const passed = await page.evaluate(async () => {
    const audio = await import('/src/lib/voiceAudio.ts');
    const clean = audio.frameMetrics(new Float32Array([0, 0.5, -1, 0]));
    if (clean.peak !== 1 || clean.clippingRatio !== 0.25) throw new Error('basic metrics');
    if (Math.abs(clean.rms - Math.sqrt(1.25 / 4)) >= 1e-6) throw new Error('RMS');
    if (Math.abs(clean.dbfs - 20 * Math.log10(clean.rms)) >= 1e-6) throw new Error('dBFS');
    if (audio.dbfsFromRms(0) !== -Infinity) throw new Error('zero dBFS');
    if (audio.classifyClipping(0) !== 'NO CLIPPING DETECTED' || audio.classifyClipping(0.001) !== 'OCCASIONAL CLIPPING' || audio.classifyClipping(0.01) !== 'FREQUENT CLIPPING') throw new Error('clipping');
    if (audio.boundedVadThreshold(null) !== audio.INITIAL_VAD_THRESHOLD || audio.boundedVadThreshold(0.2) !== audio.MAX_VAD_THRESHOLD || audio.boundedVadThreshold(-1) !== audio.MIN_VAD_THRESHOLD) throw new Error('bounds');

    const vad = new audio.VoiceActivityDetector();
    for (let index = 0; index < audio.VAD_CALIBRATION_FRAMES; index += 1) {
      if (vad.process(0.01, index * 20).event !== null) throw new Error('calibration');
    }
    if (vad.process(0.2, 200).event !== null) throw new Error('single spike');
    if (vad.process(0.01, 220).state !== 'SILENCE') throw new Error('spike recovery');
    if (vad.process(0.08, 300).event !== null || vad.process(0.08, 320).event !== null || vad.process(0.08, 340).event !== 'VOICE_START') throw new Error('voice start');
    const pause = vad.process(0.01, 400);
    if (vad.state !== 'VOICE_ACTIVE' || pause.event !== null || vad.state !== 'VOICE_ACTIVE') throw new Error('short pause');
    if (vad.process(0.01, 800).event !== null || vad.process(0.01, 1100).event !== 'VOICE_END' || vad.process(0.01, 1120).event !== null) throw new Error('voice end');

    const noisyVad = new audio.VoiceActivityDetector();
    for (let index = 0; index < audio.VAD_CALIBRATION_FRAMES; index += 1) noisyVad.process(0.08, index * 20);
    if (noisyVad.process(0.09, 200).event !== null || noisyVad.process(0.09, 220).event !== null || noisyVad.process(0.09, 240).event !== null) throw new Error('noisy false start');
    if (noisyVad.process(0.11, 300).event !== null || noisyVad.process(0.11, 320).event !== null || noisyVad.process(0.11, 340).event !== 'VOICE_START') throw new Error('quiet voice');
    return true;
  });
  assert.equal(passed, true);

  console.log('VOICE AUDIO UNIT PASS: RMS, peak, dBFS, clipping, noise floor bounds, VAD start/active/end, spike rejection, pause tolerance');
} finally {
  await browser?.close();
  await server?.close();
}