// VOICE-5 — DICTATION vs COMMAND mode UI + full pipeline integration
// test. Mounts the REAL CommandBar + useVoiceCommandPipeline together
// (scripts/voice-intent-mode-harness.jsx), drives the mode toggle via
// real clicks, and confirms the SAME transcript produces two different
// behaviors depending on mode (mission item 43).
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser, server, assertions = 0;
const check = (value, label) => { if (!value) throw new Error(`FAILED: ${label}`); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/voice-intent-mode-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Voice intent mode browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-voice-intent-mode',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/voice-intent-mode-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5210, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Voice intent mode browser error:', e.message); });

  await page.route('**/__voice_intent_mode_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__voice_intent_mode_test`);
  await page.waitForFunction(() => !!window.__voiceHarness);

  // simulate() runs the transcript through the real pipeline INSIDE a
  // React state update, then waits for React to flush before returning —
  // page.evaluate() itself resolves before React's commit phase finishes
  // rendering to the DOM, so every read after it must wait for the
  // expected text rather than reading immediately.
  async function simulate(text) {
    await page.evaluate(t => window.__voiceHarness.simulateTranscript(t), text);
  }
  async function waitForTestIdText(testId, expected) {
    await page.getByTestId(testId).filter({ hasText: expected }).first().waitFor({ timeout: 5000 });
  }

  // ── UI mode toggle is visible before speaking (mission item 3) ────────
  await page.getByRole('radio', { name: 'Dictée' }).waitFor();
  await page.getByRole('radio', { name: 'Commande' }).waitFor();
  check(await page.getByRole('radio', { name: 'Dictée' }).getAttribute('aria-checked') === 'true', 'DICTATION is the visible default mode (mission item 4)');

  // ── DICTATION mode: transcript becomes text, never interpreted ────────
  await simulate('ouvre sentinel');
  await waitForTestIdText('dictated-text', 'ouvre sentinel');
  check(await page.getByTestId('opened-feature').innerText() === '', 'DICTATION: no feature was opened');

  // ── Switch to COMMAND mode via the visible toggle (real click) ────────
  await page.getByRole('radio', { name: 'Commande' }).click();
  await page.waitForFunction(() => window.__voiceHarness.getMode() === 'COMMAND');
  check(await page.getByRole('radio', { name: 'Commande' }).getAttribute('aria-checked') === 'true', 'mode switched to COMMAND via explicit UI action');

  // ── COMMAND mode: the SAME phrase now resolves to an intent (mission 43) ─
  await simulate('ouvre sentinel');
  await waitForTestIdText('opened-feature', 'cyber-audit');
  check(await page.getByTestId('feedback-intent').innerText() === 'OPEN_FEATURE', 'feedback panel shows the resolved intent type');

  // ── STOP is deterministic and immediate in COMMAND mode ───────────────
  await simulate('arrête');
  await waitForTestIdText('log', 'stopSpeaking');

  // ── Search query passes through as data ───────────────────────────────
  await simulate('cherche les nouvelles du jour');
  await waitForTestIdText('log', 'runSearchQuery:les nouvelles du jour');

  // ── Camera intents wired through the same registry (mission item 30) ──
  await simulate('active la caméra');
  await waitForTestIdText('log', 'cameraOn');
  await simulate('désactive la caméra');
  await waitForTestIdText('log', 'cameraOff');

  // ── Switch back to DICTATION — mode is never silently changed ─────────
  await page.getByRole('radio', { name: 'Dictée' }).click();
  await page.waitForFunction(() => window.__voiceHarness.getMode() === 'DICTATION');
  await simulate('ouvre metagpt');
  await waitForTestIdText('dictated-text', 'ouvre metagpt');
  check(true, 'after switching back to DICTATION, the same phrase is text again, not an action');
  // openedFeature must still be the earlier "cyber-audit" value, never
  // overwritten by a second OPEN_FEATURE call this time.
  check(await page.getByTestId('opened-feature').innerText() === 'cyber-audit', 'DICTATION after switching back does not trigger a new OPEN_FEATURE call');

  // ── Confirmation UI: NEEDS_CLARIFICATION requires confirm/cancel, and
  // both are reachable by mouse click, never voice-only (mission item 50) ─
  await page.evaluate(() => window.__voiceHarness.triggerClarificationExample());
  await waitForTestIdText('needs-confirmation', 'true');
  await page.getByText('Confirmation requise').waitFor();
  await page.getByRole('button', { name: 'Confirmer', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Annuler', exact: true }).waitFor();

  // Cancel via mouse click clears the pending confirmation.
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page.waitForFunction(() => window.__voiceHarness.getPending() === null);
  check(true, 'Annuler button click clears the pending confirmation (mouse-operable cancel)');

  // Re-trigger and confirm via mouse click this time.
  await page.evaluate(() => window.__voiceHarness.triggerClarificationExample());
  await waitForTestIdText('needs-confirmation', 'true');
  await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
  await page.waitForFunction(() => window.__voiceHarness.getPending() === null);
  check(true, 'Confirmer button click resolves the pending confirmation (mouse-operable confirm)');

  check(errors.length === 0, 'no uncaught page errors');
  console.log(`VOICE INTENT MODE PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
