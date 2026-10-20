// [COMP-9 CHAT] REAL local-model harness for the Companion chat — the post-COMP-7 path end to end:
//   real chat UI (Chromium) → real HTTP port → real route POST /companion/answers (Hono node server, loopback)
//   → real product wiring (context engine + COMP-7 read-only KG port on the REAL graph, opened read-only)
//   → Companion model → Model Router V1 (AUTO) → REAL local runtime on 127.0.0.1:11434 → answer → UI.
// Data safety: the real KG is opened read-only (no migration); the Companion store is a throwaway temp file (the real
// Companion store is never opened); memory is OFF (NB-5 is never read). Real DB files are hashed before/after.
// A loopback TCP proxy sits between the model client and the runtime: it proves cancellation at the transport level and
// simulates "runtime unavailable" (listener closed) and its return (listener reopened) without touching the runtime.
// No download, no pull, no Ollama CLI, no cloud. Prints counts/codes/timings; never prints graph labels.
// Usage: node scripts/test-companion-chat-real-local.mjs <out.json>   (exit 3 = NOT_RUN: no local runtime on loopback)
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { KnowledgeGraphStore } from '../cortex-server/src/lib/kg-store.js';
import { COMPANION_KG_LIMITS } from '../cortex-server/src/lib/kg-companion-context.js';
import { CompanionStore } from '../cortex-server/src/lib/companion-store.js';
import { wireCompanionConversation } from '../cortex-server/src/lib/wire-companion-conversation.js';
import { createCompanionUiRoute } from '../cortex-server/src/routes/companion.js';
import { createOllamaClient } from '../cortex-server/src/lib/ollama.js';
import { detectLocalHardwareProfile } from '../cortex-server/src/lib/local-hardware-profile.js';

const OUT = process.argv[2] ?? path.join(os.tmpdir(), 'companion-chat-real-local.json');
const cortexRequire = createRequire(path.resolve('cortex-server', 'package.json'));
const { Hono } = await import(pathToFileURL(cortexRequire.resolve('hono')).href);
const { cors } = await import(pathToFileURL(cortexRequire.resolve('hono/cors')).href);
const { serve } = await import(pathToFileURL(cortexRequire.resolve('@hono/node-server')).href);
const Database = cortexRequire('better-sqlite3'); // installed in cortex-server only

const DATA = path.resolve('cortex-server', 'data');
const DB = path.join(DATA, 'cortex.sqlite');
const WATCHED = [DB, `${DB}-wal`, path.join(DATA, 'companion-v1', 'companion.sqlite')];
const hash = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');
const R = { runtime: {}, cases: {}, network: {}, files: {} };
const now = () => performance.now();
const ms = (x) => Math.round(x);

// ── 0. local runtime present? (loopback TCP only — no CLI, nothing started here) ──
const up = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 11434 });
  s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
});
if (!up) { console.log('REAL_LOCAL_MODEL_NOT_RUN: nothing listens on 127.0.0.1:11434'); fs.writeFileSync(OUT, JSON.stringify({ status: 'NOT_RUN' })); process.exit(3); }

// every fetch of this process must stay on loopback
let externalFetch = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init);
  externalFetch += 1; throw new Error(`external network refused: ${u.hostname}`);
};

// ── loopback TCP proxy in front of the runtime ──
function startProxy(upstreamPort) {
  const stats = { connections: 0, clientClosedEarly: 0 };
  const sockets = new Set();
  let server = null; let port = 0;
  const listen = () => new Promise((resolve) => {
    server = net.createServer((client) => {
      stats.connections += 1; sockets.add(client);
      const upstream = net.connect(upstreamPort, '127.0.0.1');
      let upstreamEnded = false;
      client.pipe(upstream); upstream.pipe(client);
      upstream.on('end', () => { upstreamEnded = true; });
      client.on('close', () => { sockets.delete(client); if (!upstreamEnded) stats.clientClosedEarly += 1; upstream.destroy(); });
      upstream.on('close', () => client.destroy());
      client.on('error', () => {}); upstream.on('error', () => client.destroy());
    });
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  const close = () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
  return { stats, listen, close, get port() { return port; } };
}

// ── real router settings, read-only (the Companion model forces cloud off anyway) ──
const ro = new Database(DB, { readonly: true, fileMustExist: true });
const storedSettings = JSON.parse(ro.prepare("SELECT value FROM metadata WHERE key = 'router_settings'").pluck().get() ?? '{}');
assert.equal(ro.prepare("SELECT value FROM kg_metadata WHERE key = 'activation_state'").pluck().get(), 'ACTIVE', 'real KG is active');
const sample = ro.prepare(`SELECT video.name AS videoLabel FROM kg_relationships r JOIN kg_entities video ON video.entity_id = r.source_entity_id
  WHERE r.relationship_type = 'MEMBER_OF' AND video.name GLOB '*[A-Za-z]*' AND length(video.name) BETWEEN 12 AND 90 ORDER BY r.relationship_id LIMIT 1`).get();
ro.close();
R.runtime.strictLocalMode = storedSettings.strict_local_mode ?? null;
const filesBefore = Object.fromEntries(WATCHED.map(f => [path.basename(f), hash(f)]));

const proxy = startProxy(11434);
await proxy.listen();
const kgStore = new KnowledgeGraphStore(DB, { readOnly: true, production: true, timeout: COMPANION_KG_LIMITS.timeoutMs });
kgStore.open();
kgStore.initialized = true; // never run migrations on the production graph
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp9-real-'));
const companionStore = CompanionStore.open({ dbPath: path.join(TMP, 'companion.sqlite') });
const logs = [];
const logger = { info: (o, m) => logs.push({ o, m }), warn: (o, m) => logs.push({ o, m }), error: (o, m) => logs.push({ o, m }) };
const companion = {
  preferences: () => ({ memoryEnabled: false, sessionMemoryEnabled: false, proposalEnabled: false, cloudContextEnabled: false }),
  session: { list: () => [] }, view: () => null, recordContextAssembly: () => { throw new Error('no context record with memory off'); },
};
const memoryPort = { retrieve: async () => { throw new Error('NB-5 must not be read with memory off'); } };
const { conversation, kgGate } = wireCompanionConversation({
  companion, memoryPort, kgStore, env: {}, client: createOllamaClient(`http://127.0.0.1:${proxy.port}`), store: companionStore,
  getSettings: () => storedSettings, getHardware: () => detectLocalHardwareProfile(), logger,
});
R.kgGate = kgGate.reason;

// status / session stubs for the panel; the ANSWER route is the shipped one
const service = {
  getStatus: async () => ({ activation: 'ACTIVE', schemaVersion: 4, preferences: companion.preferences(), model: { status: 'NOT_RUN', code: null, at: null, source: 'COMPANION_MODEL_AUDIT' } }),
  listMemories: async () => [], listProposals: async () => [], openUiSession: async () => ({ uiSessionId: 's'.repeat(32) }), closeUiSession: async () => true,
};
const VITE_PORT = 5281;
const ORIGIN = `http://127.0.0.1:${VITE_PORT}`;
const app = new Hono();
app.use('*', cors({ origin: ORIGIN }));
app.route('/api', createCompanionUiRoute({ service, conversation, logger }));
const apiServer = await new Promise((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)); });
const API = `http://127.0.0.1:${apiServer.address().port}`;

const HARNESS_HTML = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/companion-chat-harness.jsx");mount();</script></body></html>';
const vite = await createServer({ configFile: false, cacheDir: '.tmp/vite-comp9-real', plugins: [react(), { name: 'h', configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url.startsWith('/__chat')) { res.setHeader('content-type', 'text/html'); res.end(HARNESS_HTML); } else next(); }); } }], optimizeDeps: { entries: ['scripts/companion-chat-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: VITE_PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
let blockedBrowser = 0;
page.on('pageerror', (e) => { R.pageErrors = [...(R.pageErrors ?? []), e.message.slice(0, 200)]; });
await page.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.hostname === '127.0.0.1') return r.continue(); blockedBrowser += 1; return r.abort(); });

const gpuUsedMiB = () => { try { return Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0]); } catch { return null; } };
const loaded = async () => { try { const r = await realFetch('http://127.0.0.1:11434/api/ps'); return (await r.json()).models?.map(m => ({ name: m.name, sizeMiB: Math.round(m.size / 2 ** 20), vramMiB: Math.round((m.size_vram ?? 0) / 2 ** 20) })) ?? []; } catch { return null; } };

/** Ask through the REAL UI; returns the route's JSON value and UI timings. */
async function askUi(text, { expect = 'answer', timeout = 120_000 } = {}) {
  await page.getByTestId('cmp-chat-input').fill(text);
  const response = page.waitForResponse((r) => r.url() === `${API}/api/companion/answers`, { timeout });
  const t0 = now();
  await page.getByTestId('cmp-chat-send').click();
  await page.getByTestId('cmp-chat-pending').waitFor({ timeout: 5000 });
  const res = await response;
  const body = await res.json();
  const last = page.locator(expect === 'answer' ? '[data-testid="cmp-chat-answer"]' : '[data-testid="cmp-chat-error"]').last();
  await last.waitFor({ timeout });
  return { status: res.status(), body, uiMs: ms(now() - t0), shown: await last.innerText() };
}

let exitCode = 0;
try {
  await page.goto(`${ORIGIN}/__chat?api=${encodeURIComponent(API)}`);
  await page.getByTestId('cmp-chat-empty').waitFor();
  R.gpuBeforeMiB = gpuUsedMiB();

  // A — simple French question, no special context
  const a = await askUi('Réponds en une seule phrase courte, en français : quelle est la capitale de la France ?');
  R.cases.A = { status: a.status, uiMs: a.uiMs, serverMs: a.body.value?.durationMs ?? null, model: a.body.value?.model ?? null, local: a.body.value?.local ?? null,
    chars: a.body.value?.text?.length ?? 0, text: a.body.value?.text ?? null, kgContextUsed: a.body.value?.diagnostics?.kgContextUsed ?? null, shownInUi: a.shown.includes((a.body.value?.text ?? '').slice(0, 20)) };
  R.loadedAfterA = await loaded();
  R.gpuAfterAMiB = gpuUsedMiB();
  await page.screenshot({ path: '.tmp/companion-real-A.png' });

  // B — a question the real graph can inform (label never printed)
  if (sample) {
    const b = await askUi(`Dans quelles collections ou playlists se trouve la vidéo « ${sample.videoLabel} » ? Réponds brièvement.`);
    const v = b.body.value ?? {};
    R.cases.B = { status: b.status, uiMs: b.uiMs, serverMs: v.durationMs ?? null, model: v.model ?? null, kgContextUsed: v.diagnostics?.kgContextUsed ?? null,
      kgUsed: v.diagnostics?.kg?.used ?? null, kgStatus: v.diagnostics?.kg?.status ?? null, provenanceItems: v.kgProvenance?.length ?? 0,
      provenanceAuthorityNone: (v.kgProvenance ?? []).every(p => p.authority === 'NONE'), chars: v.text?.length ?? 0,
      sourcesShownInUi: (await page.getByTestId('cmp-chat-sources').count()) > 0, answerMentionsSample: (v.text ?? '').toLowerCase().includes(sample.videoLabel.toLowerCase().slice(0, 12)) };
    await page.screenshot({ path: '.tmp/companion-real-B.png' });
  } else R.cases.B = { status: 'NOT_RUN', reason: 'no MEMBER_OF sample in the real graph' };

  // C — cancellation during a real generation
  const earlyBefore = proxy.stats.clientClosedEarly;
  const answersBeforeC = await page.getByTestId('cmp-chat-answer').count();
  await page.getByTestId('cmp-chat-input').fill('Écris un très long texte d’au moins 800 mots sur l’histoire de la Provence, avec beaucoup de détails.');
  const tSend = now();
  await page.getByTestId('cmp-chat-send').click();
  await page.getByTestId('cmp-chat-pending').waitFor();
  await page.waitForTimeout(2500); // the model is generating
  const tCancel = now();
  await page.getByTestId('cmp-chat-cancel').click();
  await page.getByTestId('cmp-chat-cancelled').waitFor({ timeout: 5000 });
  const uiCancelMs = ms(now() - tCancel);
  let transportMs = null;
  for (let i = 0; i < 200; i++) { if (proxy.stats.clientClosedEarly > earlyBefore) { transportMs = ms(now() - tCancel); break; } await new Promise(r => setTimeout(r, 25)); }
  await page.waitForTimeout(1000);
  R.cases.C = { generatedForMs: ms(tCancel - tSend), uiCancelMs, runtimeConnectionClosedAfterMs: transportMs,
    serverCancelled: logs.some(l => l.m === 'COMPANION_ANSWER_FAILED' && /CANCEL/.test(String(l.o?.code))),
    orphanSpinner: await page.getByTestId('cmp-chat-pending').count(), lateAnswerShown: (await page.getByTestId('cmp-chat-answer').count()) > answersBeforeC };

  // D — runtime unavailable (the runtime endpoint stops listening): clear error, no crash
  await proxy.close();
  const d = await askUi('Bonjour, es-tu là ?', { expect: 'error', timeout: 60_000 });
  R.cases.D = { status: d.status, code: d.body.error?.code ?? null, uiText: d.shown.trim().slice(0, 120), pageErrors: (R.pageErrors ?? []).length };
  await page.screenshot({ path: '.tmp/companion-real-D.png' });

  // E — the runtime comes back: the next request succeeds without reloading the page
  await proxy.listen();
  const e = await askUi('Réponds seulement par « oui » : es-tu de retour ?');
  R.cases.E = { status: e.status, uiMs: e.uiMs, model: e.body.value?.model ?? null, chars: e.body.value?.text?.length ?? 0, text: e.body.value?.text ?? null, reloaded: false };
  R.loadedEnd = await loaded();
  R.gpuEndMiB = gpuUsedMiB();
} catch (error) {
  R.error = String(error?.stack ?? error).slice(0, 1500); exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  await new Promise((r) => apiServer.close(() => r()));
  await proxy.close().catch(() => {});
  try { kgStore.close(); } catch { /* closed */ }
  try { companionStore.close(); } catch { /* closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
  globalThis.fetch = realFetch;
  const filesAfter = Object.fromEntries(WATCHED.map(f => [path.basename(f), hash(f)]));
  R.files = { unchanged: JSON.stringify(filesBefore) === JSON.stringify(filesAfter), watched: Object.keys(filesBefore).length };
  R.network = { externalFetch, blockedBrowser, proxyConnections: proxy.stats.connections };
  R.logsContentFree = sample ? !JSON.stringify(logs).includes(sample.videoLabel) : true;
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ ...R, cases: Object.fromEntries(Object.entries(R.cases).map(([k, v]) => [k, { ...v, text: v.text ? `${v.text.slice(0, 160)}` : undefined }])) }, null, 1));
}
process.exit(exitCode);
