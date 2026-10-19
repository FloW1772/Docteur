// Companion V1 — real local model harness, rebuilt in COMP-REMED-1 as a REAL node:test suite.
//
// Why rebuilt (COMP-CERT blockers D and E):
//   D  the COMP-8 harness asked for `runtime.models[0].name` — the FIRST entry of /api/tags, which Ollama orders by
//      modification time — so the "requested" model drifted (llama3.2:3b at COMP-8, llava:7b at COMP-CERT). The
//      Companion never chose llava: the harness did. Now: AUTO (requestedModel null) → Model Router V1 decides; the
//      requested mode, effective provider and effective model are reported as returned, never masked.
//   E  the timeout case used timeoutMs 100, below MODEL_TIMEOUT_BOUNDS (1000..120000): MODEL_REQUEST_INVALID was the
//      correct refusal. Now: 1000 ms on a long generation, reproduced 3×, with TRANSPORT evidence from a loopback TCP
//      proxy (the client closed the chat connection before any response byte → the AbortSignal reached the socket;
//      the proxy then closes the upstream so Ollama stops), and a late answer never produces a success.
//   +  the old script started every case concurrently without awaiting them, referenced a store API that does not exist
//      (store.memory) and never set an exit code.
// Model ANSWER content is model behaviour: recorded as OBSERVED diagnostics, never asserted as a contract. Status,
// routing, honesty, locality, cost, cancellation and timeout ARE asserted.
// No download, no pull, no Ollama CLI: loopback HTTP only. Temporary stores / temporary NB-5 DB only.
// Skips (NOT_RUN, explicit) when no local runtime answers on 127.0.0.1:11434.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { ensureMemorySchema } from './src/lib/notebook-memory-schema.js';
import { createOllamaClient } from './src/lib/ollama.js';
import { CompanionStore } from './src/lib/companion-store.js';
import { CompanionMemory } from './src/lib/companion-memory.js';
import { createCompanionContextEngine } from './src/lib/companion-context.js';
import { createCompanionModel, LOCAL_COST } from './src/lib/companion-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA = { host: '127.0.0.1', port: 11434 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-remed-real-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const LONG = 'Écris une histoire extrêmement longue et détaillée de l’informatique, des origines à aujourd’hui, en au moins trois mille mots, chapitre par chapitre.';

let runtime = null;
try {
  const r = await fetch(`http://${OLLAMA.host}:${OLLAMA.port}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  if (r.ok) runtime = (await r.json()).models?.map(m => m.name) ?? [];
} catch { runtime = null; }
const skip = !runtime || runtime.length === 0 ? 'NOT_RUN: no local Ollama runtime on 127.0.0.1:11434' : false;

// ── loopback TCP proxy: observes the client side of every connection ──
async function startProxy() {
  const stats = { chats: 0, abortedBeforeResponse: 0, completedResponses: 0 };
  const sockets = new Set();
  const server = net.createServer((client) => {
    const up = net.connect(OLLAMA.port, OLLAMA.host);
    sockets.add(client); sockets.add(up);
    let pendingChat = false;
    client.on('data', (d) => { if (d.toString('latin1', 0, 16).startsWith('POST /api/chat')) { pendingChat = true; stats.chats++; } up.write(d); });
    up.on('data', (d) => { if (pendingChat) { pendingChat = false; stats.completedResponses++; } client.write(d); });
    client.on('close', () => { if (pendingChat) { pendingChat = false; stats.abortedBeforeResponse++; } up.destroy(); });
    up.on('close', () => client.destroy());
    client.on('error', () => up.destroy()); up.on('error', () => client.destroy());
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { stats, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

const realFetch = globalThis.fetch; let externalCalls = 0; let realDbBefore; let proxy; const stores = []; const observed = [];
before(async () => {
  realDbBefore = REAL_DB.map(fileHash);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    externalCalls++; throw new Error(`external network refused: ${url.hostname}`);
  };
  initSqlite(path.join(TMP, 'docteur-temp.sqlite'));
  ensureMemorySchema(getDatabase());
  if (!skip) proxy = await startProxy();
});
after(async () => {
  globalThis.fetch = realFetch;
  if (proxy) await proxy.close();
  for (const s of stores) { try { s.close(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
  if (observed.length) console.log(`REAL_LOCAL_OBSERVED ${JSON.stringify(observed)}`);
});

const DIM = 32;
const embed = async (t) => { const v = new Array(DIM).fill(0); for (const w of String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; } const nn = Math.hypot(...v) || 1; return v.map(x => x / nn); };
let nb5 = null;
const nb5Svc = () => (nb5 ??= createMemoryService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, localComplete: async () => 'ok' }));
let n = 0;
function world() {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `c-${++n}.sqlite`) }); stores.push(store);
  const mem = new CompanionMemory({ store, nb5: nb5Svc() });
  const engine = createCompanionContextEngine({ companion: mem, memoryPort: nb5Svc() });
  // real Root Policy (default enforcePolicy), Strict Local, the real ollama-js client through the observing proxy
  const cm = createCompanionModel({ client: createOllamaClient(proxy.url), store, getSettings: () => ({ strict_local_mode: true }) });
  const run = async (userRequest, opts = {}) => {
    const requestId = `real-${++n}`;
    const context = await engine.assemble({ requestId, userRequest });
    return cm.executeCompanionLocal({ requestId, context, timeoutMs: 120_000, ...opts });
  };
  return { store, mem, cm, run };
}
const honesty = (r) => ({ requested: 'AUTO', routeMode: r.route?.mode, routeModelId: r.route?.modelId, effectiveProvider: r.effectiveProvider, effectiveModel: r.effectiveModel, modelReported: r.modelReported, modelMatchesRequest: r.modelMatchesRequest });

test('basic: AUTO selection through Model Router V1 — requested mode / effective provider / effective model reported as returned; local, LOCAL_NO_BILLING, 0 tool', { skip }, async (t) => {
  const w = world();
  const r = await w.run('Réponds uniquement par le mot exact : DOCTEUR_LOCAL_OK');
  assert.equal(r.status, 'COMPLETED');
  assert.deepEqual([r.local, r.effectiveProvider, r.route.mode, r.route.location], [true, 'ollama', 'auto', 'LOCAL']);
  assert.ok(runtime.includes(r.route.modelId.replace(/^ollama:/, '')), 'the routed model is installed (no download)');
  assert.equal(r.modelReported, true, 'the runtime reported which model answered');
  assert.equal(r.effectiveModel, r.route.modelId.replace(/^ollama:/, ''), 'effective model = routed model (no substitution)');
  assert.deepEqual(r.cost, LOCAL_COST);
  assert.deepEqual(r.tools, []);
  const h = honesty(r);
  t.diagnostic(`MODEL ${JSON.stringify(h)}`);
  observed.push({ case: 'basic', ...h, durationMs: r.durationMs, containsMarker: r.text.includes('DOCTEUR_LOCAL_OK') });
  // determinism of AUTO: the same request routes to the same model
  const again = await w.run('Réponds uniquement par le mot exact : DOCTEUR_LOCAL_OK');
  assert.equal(again.route.modelId, r.route.modelId, 'AUTO is deterministic');
});

test('French: completed locally; the answer language is OBSERVED', { skip }, async (t) => {
  const w = world();
  const r = await w.run('Explique en deux phrases ce qu’est une mémoire locale pour un assistant personnel.');
  assert.equal(r.status, 'COMPLETED');
  assert.ok(r.text.trim().length > 0);
  const french = /\b(le|la|les|une|est|des|pour|qui)\b/i.test(r.text);
  t.diagnostic(`FRENCH ${french ? 'PASS_OBSERVED' : 'MODEL_BEHAVIOR_WEAKNESS'} (${r.effectiveModel})`);
  observed.push({ case: 'french', effectiveModel: r.effectiveModel, frenchObserved: french });
});

test('context: a real NB-5 memory (temporary DB) reaches the model as DATA; its use is OBSERVED', { skip }, async (t) => {
  const w = world();
  await w.mem.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Le nom de code de mon projet personnel est Atlas.', provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' } });
  const r = await w.run('Quel est le nom de code de mon projet personnel ?');
  assert.equal(r.status, 'COMPLETED');
  assert.ok(r.contextItems >= 1, 'the memory was part of the context');
  const used = /atlas/i.test(r.text);
  t.diagnostic(`CONTEXT ${used ? 'PASS_OBSERVED' : 'MODEL_BEHAVIOR_WEAKNESS'} (${r.effectiveModel})`);
  observed.push({ case: 'context', effectiveModel: r.effectiveModel, usedMemory: used });
});

test('cancel: MODEL_CANCELLED during a long generation; the chat connection is closed by the client before any response (transport abort)', { skip }, async () => {
  const w = world();
  await w.run('Réponds : OK'); // warm: the model is loaded, so the cancel lands during generation, not loading
  const before = { ...proxy.stats };
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 1_000);
  await assert.rejects(w.run(LONG, { signal: ac.signal, timeoutMs: 60_000 }), (e) => e.code === 'MODEL_CANCELLED' && e.details.stage === 'DURING_GENERATION');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `immediate (${elapsed} ms)`);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(proxy.stats.abortedBeforeResponse - before.abortedBeforeResponse, 1, 'the client closed the chat connection mid-generation');
  assert.equal(w.store.listModelAudit().filter(a => a.action === 'MODEL_COMPLETED').length, 1, 'only the warm-up completed');
  observed.push({ case: 'cancel', elapsedMs: elapsed });
});

test('timeout ×3 at the 1000 ms bound: MODEL_TIMEOUT (never CANCELLED / UNAVAILABLE / ERROR / late success), transport aborted each time, late answers ignored', { skip }, async () => {
  const w = world();
  await w.run('Réponds : OK'); // warm
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const before = { ...proxy.stats };
    const t0 = Date.now();
    let err = null;
    try { await w.run(LONG, { timeoutMs: 1_000 }); } catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    assert.ok(err, `run ${i + 1}: never a success`);
    assert.equal(err.code, 'MODEL_TIMEOUT', `run ${i + 1}: ${err.code}`);
    assert.equal(err.details.routerCode, 'TIMEOUT');
    assert.ok(elapsed >= 950 && elapsed < 4_000, `run ${i + 1}: bounded (${elapsed} ms)`);
    await new Promise(r => setTimeout(r, 1_500)); // a late answer would land here
    assert.equal(proxy.stats.abortedBeforeResponse - before.abortedBeforeResponse, 1, `run ${i + 1}: AbortSignal closed the connection`);
    assert.equal(proxy.stats.completedResponses - before.completedResponses, 0, `run ${i + 1}: no response ever delivered`);
    runs.push(elapsed);
  }
  const actions = w.store.listModelAudit().map(a => a.action);
  assert.equal(actions.filter(a => a === 'MODEL_TIMEOUT').length, 3);
  assert.equal(actions.filter(a => a === 'MODEL_COMPLETED').length, 1, 'only the warm-up completed');
  assert.equal(actions.includes('MODEL_CANCELLED'), false, 'timeout ≠ cancel');
  assert.equal(w.store.verifyModelAudit().ok, true);
  observed.push({ case: 'timeout', reproductions: runs.length, elapsedMs: runs });
});

test('manual absent model: LOCAL_MODEL_UNAVAILABLE / MODEL_NOT_INSTALLED, no fallback, no chat sent; manual present model honoured exactly', { skip }, async () => {
  const w = world();
  const absent = 'docteur-absent-model:1b';
  assert.equal(runtime.includes(absent), false);
  const before = { ...proxy.stats };
  await assert.rejects(w.run('Bonjour', { requestedModel: absent }), (e) => e.code === 'LOCAL_MODEL_UNAVAILABLE' && e.details.routerCode === 'MODEL_NOT_INSTALLED');
  assert.equal(proxy.stats.chats - before.chats, 0, 'no other model was asked instead');
  if (runtime.includes('llama3.2:3b')) {
    const r = await w.run('Réponds : OK', { requestedModel: 'llama3.2:3b' });
    assert.deepEqual([r.route.mode, r.requestedModel, r.effectiveModel, r.modelMatchesRequest], ['manual', 'llama3.2:3b', 'llama3.2:3b', true]);
  }
});

test('isolation: 0 external network, real user DB untouched', { skip }, () => {
  assert.equal(externalCalls, 0);
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore);
});
