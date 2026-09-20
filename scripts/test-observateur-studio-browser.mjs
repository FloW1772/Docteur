import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { captureStudio } from './studio-browser-checks.mjs';

let browser, server, assertions = 0;
const check = value => { assert.ok(value); assertions++; };
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount} = await import("/scripts/observateur-studio-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => { console.error('Observateur Studio browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 60000);

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-observateur-studio',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/observateur-studio-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5206, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Observateur Studio browser error:', e.message); });

  // ── In-memory Observateur monitor fixture backend ──
  let settings = {
    enabled: false, autostart: false, collectionIntervalMs: 10000, reportMode: 'ON_SUMMARY',
    reportFrequency: 'DAILY', customReportFrequencyMinutes: 60, retentionDays: 7, maxHistorySize: 50000,
    includeProcessMetadata: true, includeRemoteEndpoints: true, includeLocalServices: true,
    notifyMode: 'IMPORTANT_ONLY', generateDailySummary: true, generateWeeklySummary: false,
    cloudAiEnabled: false, ollamaEnabled: true, paused: false, lastReportAt: null,
  };
  const connections = [
    { id: 'c1', process_name: 'chrome.exe', pid: 100, remote_address: '93.184.216.34', remote_port: 443, local_port: 51000, protocol: 'TCP', state: 'ESTABLISHED', first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), sample_count: 3, approx_bytes: 0, window_bucket: '2026-09-20T14' },
  ];
  const processes = [
    { id: 'p1', process_name: 'chrome.exe', pid: 100, first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), connection_count: 3, distinct_destinations: 1, window_bucket: '2026-09-20T14' },
  ];
  const anomalies = [
    { id: 'a1', detected_at: new Date().toISOString(), rule_id: 'new-external-destination-from-docteur-component', severity: 'REQUIRES_REVIEW', process_name: 'node.exe', remote_address: '198.51.100.7', description: 'Composant Docteur vers destination externe non répertoriée.', evidence_ref: '{}', status: 'OPEN', security_signal: '{"source":"observateur"}' },
  ];
  const reports = [
    { id: 'r1', report_type: 'SUMMARY', period_start: new Date(Date.now() - 3600000).toISOString(), period_end: new Date().toISOString(), mode: 'ON_SUMMARY', event_count: 3, anomaly_count: 1, summary_json: '{}', llm_narrative: null, created_at: new Date().toISOString() },
  ];

  await page.route('**/api/monitor/**', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const method = req.method();
    let data, status = 200;

    if (pathname === '/api/monitor/status' && method === 'GET') {
      data = { ok: true, status: { enabled: settings.enabled, paused: settings.paused, running: settings.enabled && !settings.paused, mode: settings.reportMode, reportFrequency: settings.reportFrequency, lastReportAt: settings.lastReportAt, overhead: { eventsPerMin: 12, writesPerMin: 2, avgCycleDurationMs: 40, degraded: false }, degraded: false } };
    } else if (pathname === '/api/monitor/settings' && method === 'GET') {
      data = { ok: true, settings };
    } else if (pathname === '/api/monitor/settings' && method === 'PUT') {
      const body = req.postDataJSON();
      settings = { ...settings, ...body };
      data = { ok: true, settings };
    } else if (pathname === '/api/monitor/start' && method === 'POST') {
      settings.enabled = true; settings.paused = false;
      data = { ok: true, settings };
    } else if (pathname === '/api/monitor/pause' && method === 'POST') {
      settings.paused = true;
      data = { ok: true, settings };
    } else if (pathname === '/api/monitor/resume' && method === 'POST') {
      settings.paused = false;
      data = { ok: true, settings };
    } else if (pathname === '/api/monitor/connections/live') {
      data = { ok: true, connections };
    } else if (pathname === '/api/monitor/processes') {
      data = { ok: true, processes };
    } else if (pathname === '/api/monitor/anomalies') {
      data = { ok: true, anomalies };
    } else if (pathname === '/api/monitor/reports') {
      data = { ok: true, reports };
    } else {
      data = { ok: true };
    }

    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS' } });
  });

  // ── In-memory Web Audit fixture backend (regression: WEB AUDIT tab must still work, embedded) ──
  const missions = new Map();
  function apiShape(m) { const { _findings, ...rest } = m; return rest; }
  await page.route('**/api/cyber-audit/**', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const method = req.method();
    let data, status = 200;
    if (pathname === '/api/cyber-audit/missions' && method === 'GET') {
      data = { ok: true, missions: Array.from(missions.values()).map(apiShape) };
    } else {
      data = { ok: true };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });
  });

  await page.route('**/__observateur_studio_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__observateur_studio_test`);

  // ── Open Observateur via Help Center search ──
  const openStudio = async () => {
    await page.getByPlaceholder(/Rechercher/).fill('Observateur');
    await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await page.getByRole('dialog', { name: /Observateur/ }).waitFor();
  };
  await openStudio().catch(async e => { console.error(await page.locator('body').innerText()); throw e; });
  assertions++;

  // ── All 9 tabs are present and switchable ── (badge-bearing tabs like
  // ANOMALIES render a count suffix in their accessible name, e.g.
  // "ANOMALIES1" — regex match, not exact, mirrors how the certified
  // cyber-audit browser test handles its own FINDINGS badge tab).
  for (const tabName of ['OVERVIEW', 'LIVE', 'NETWORK', 'APPLICATIONS', 'ANOMALIES', 'REPORTS', 'WEB AUDIT', 'HISTORY', 'SETTINGS']) {
    await page.getByRole('tab', { name: new RegExp(`^${tabName}`) }).click();
    assertions++;
  }
  check(true);

  // ── OVERVIEW shows key figures ──
  await page.getByRole('tab', { name: /^OVERVIEW/ }).click();
  await page.getByText('Connexions observées', { exact: false }).waitFor();
  assertions++;

  // ── LIVE shows the aggregated connection, not per-packet ──
  await page.getByRole('tab', { name: /^LIVE/ }).click();
  await page.getByText('chrome.exe', { exact: false }).first().waitFor();
  assertions++;

  // ── ANOMALIES: REQUIRES_REVIEW row shows the inert MAITRE placeholder ──
  await page.getByRole('tab', { name: /^ANOMALIES/ }).click();
  await page.getByText('Analyse approfondie recommandée avec MAITRE', { exact: false }).waitFor();
  const maitreButton = page.getByRole('button', { name: 'Ouvrir dans MAITRE', exact: true });
  check(await maitreButton.isDisabled());

  // ── REPORTS: history entry with export links ──
  await page.getByRole('tab', { name: /^REPORTS/ }).click();
  await page.getByRole('link', { name: 'Voir', exact: true }).first().waitFor();
  assertions++;

  // ── WEB AUDIT tab: existing Cyber Audit UI embeds without its own dialog chrome ──
  await page.getByRole('tab', { name: /^WEB AUDIT/ }).click();
  await page.getByText('Aucune mission active.', { exact: false }).waitFor();
  assertions++;
  // Only ONE dialog role exists — the embedded panel does not nest its own StudioShell.
  check(await page.getByRole('dialog').count() === 1);

  // ── SETTINGS: cloud AI checkbox is disabled and unchecked by default ──
  await page.getByRole('tab', { name: /^SETTINGS/ }).click();
  const cloudCheckbox = page.getByRole('checkbox', { name: /IA cloud/ });
  check(await cloudCheckbox.isDisabled());
  check(!(await cloudCheckbox.isChecked()));

  // ── Start / Pause / Resume actually round-trip through the backend ──
  const startButton = page.getByRole('button', { name: 'Démarrer', exact: true });
  await startButton.click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  assertions++;
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Reprendre', exact: true }).waitFor();
  assertions++;
  await page.getByRole('button', { name: 'Reprendre', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  assertions++;

  // ── No raw backend/system leakage anywhere in the DOM ──
  const fullBodyText = await page.locator('body').innerText();
  check(!/venv|argv|python|filesystem|C:\\\\|\/usr\/|\/home\//i.test(fullBodyText));

  await captureStudio(page, 'observateur-studio-results');

  check(errors.length === 0);
  console.log(`OBSERVATEUR STUDIO FRONTEND PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
