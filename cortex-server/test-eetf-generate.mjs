// EETF-4 — provider abstraction + hardened ComfyUI adapter + generation engine.
// A FAKE ComfyUI on 127.0.0.1 only. No real ComfyUI, no model, no download, no
// cloud: global fetch is wrapped and refuses (and counts) any non-loopback URL.
// Real Root Policy decision for AI_LOCAL_REQUEST (module ai) unless a test
// injects a refusal. Temporary store only; the user DB is hashed before / after.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { EetfStore } from './src/lib/eetf-store.js';
import { hashFile } from './src/lib/eetf-asset-store.js';
import { createProviderRegistry, makeProviderSnapshot, negotiate, vramCheck, PROVIDER_STATE } from './src/lib/eetf-providers.js';
import { createComfyUiProvider, buildWorkflow, validateWorkflow } from './src/lib/eetf-comfyui-provider.js';
import { createEetfGenerationEngine } from './src/lib/eetf-generate.js';
import { stripPngMetadata, pngChunkTypes } from './src/lib/eetf-image-meta.js';
import { parseLoopbackEndpoint, createComfyUiClient, validateOutputRef } from './src/lib/providers/comfyui.js';
import { enforce as realEnforce } from './src/lib/root-policy/index.js';
import * as C from './src/lib/eetf-contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf4-'));
const REAL_DB_FILES = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? hashFile(p) : 'absent');
const realFetch = globalThis.fetch;
const fetched = []; let externalAttempts = 0; let realDbBefore;
const opened = []; const servers = [];

before(() => {
  realDbBefore = REAL_DB_FILES.map(fileHash);
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    fetched.push(u);
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(u)) { externalAttempts++; return Promise.reject(new Error(`non-loopback fetch blocked by the test: ${u}`)); }
    return realFetch(url, opts);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const s of opened) s.close();
  for (const s of servers) { s.closeAllConnections?.(); await new Promise(r => s.close(r)); }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.warn(`temp cleanup: ${e.message}`); }
});

const code = (c) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); return true; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── fixtures ───────────────────────────────────────────────────────────────

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, { seed = 1, text = [] } = {}) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 5 + y * 11 + seed * 17) & 0xff;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...text.map(([k, v]) => chunk('tEXt', Buffer.from(`${k}\u0000${v}`, 'latin1'))), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const MODEL = 'v1-5-pruned-emaonly-fp16.safetensors';

/** Fake ComfyUI (loopback only). Every behaviour is driven by `state`. */
async function fakeComfy(overrides = {}) {
  const state = {
    stats: 'ok', vramTotal: 8151 * 1048576, models: [MODEL, 'sd15/alt.safetensors', '../../evil.ckpt', 'C:\\models\\x.ckpt'],
    samplers: ['euler', 'dpmpp_2m', 'evil_sampler'], schedulers: ['normal', 'karras'], missingNodes: [], interruptRoute: true,
    prompt: 'ok', pendingPolls: 1, history: 'ok', view: 'ok', refs: null, log: [], running: 0, maxRunning: 0, polls: 0,
    ...overrides,
  };
  const prompts = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    state.log.push({ method: req.method, path: url.pathname, query: url.search, body });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    const mode = (m) => {
      if (m === 'hang') return true;
      if (m === 'reset') { req.socket.destroy(); return true; }
      if (m === '500') { json(500, { error: 'boom' }); return true; }
      if (m === 'badjson') { json(200, '{not json'); return true; }
      return false;
    };
    if (url.pathname === '/system_stats') {
      if (mode(state.stats)) return;
      if (state.stats === 'redirect') { res.writeHead(302, { location: `http://127.0.0.1:${state.sentinelPort}/system_stats` }); return res.end(); }
      if (state.stats === 'huge') return json(200, { system: { comfyui_version: 'x'.repeat(5 * 1024 * 1024) } });
      return json(200, { system: { comfyui_version: '0.3.99-fake' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 5060 Laptop GPU', vram_total: state.vramTotal, vram_free: state.vramTotal / 2 }] });
    }
    if (url.pathname.startsWith('/object_info/')) {
      const node = url.pathname.slice('/object_info/'.length);
      if (state.missingNodes.includes(node)) return json(200, {});
      const required = node === 'CheckpointLoaderSimple' ? { ckpt_name: [state.models] } : node === 'KSampler' ? { sampler_name: [state.samplers], scheduler: [state.schedulers] } : {};
      return json(200, { [node]: { input: { required } } });
    }
    if (url.pathname === '/interrupt') {
      if (!state.interruptRoute) return json(404, {});
      if (req.method === 'GET') return json(405, {});
      return json(200, {});
    }
    if (url.pathname === '/queue' && req.method === 'POST') return json(200, {});
    if (url.pathname === '/prompt' && req.method === 'POST') {
      if (mode(state.prompt)) return;
      if (state.prompt === '400') return json(400, { error: { type: 'prompt_outputs_failed_validation' }, node_errors: { 3: {} } });
      const wf = JSON.parse(body).prompt;
      const id = crypto.randomUUID();
      prompts.set(id, { wf, polls: 0 });
      state.running++; state.maxRunning = Math.max(state.maxRunning, state.running);
      return json(200, { prompt_id: id, number: 1, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      state.polls++;
      const id = url.pathname.slice('/history/'.length);
      const p = prompts.get(id);
      if (!p) return json(200, {});
      if (++p.polls <= state.pendingPolls) return json(200, {});
      state.running = Math.max(0, state.running - 1);
      const batch = p.wf['5'].inputs.batch_size;
      if (state.history === 'error' || state.history === 'oom') return json(200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: state.history === 'oom' ? 'CUDA out of memory' : 'boom' }]] } } });
      const refs = state.refs ?? Array.from({ length: batch }, (_, i) => ({ filename: `eetf_0000${i + 1}_.png`, subfolder: '', type: 'output' }));
      const outputs = state.history === 'noimages' ? {} : { 9: { images: refs } };
      return json(200, { [id]: { prompt: [1, id, p.wf], outputs, status: { status_str: 'success', completed: true, messages: [] } } });
    }
    if (url.pathname === '/view') {
      const name = url.searchParams.get('filename');
      const last = [...prompts.values()].at(-1)?.wf;
      const w = last?.['5'].inputs.width ?? 64; const h = last?.['5'].inputs.height ?? 64;
      const idx = Number(/_(\d+)_\.png$/.exec(name)?.[1] ?? 1) - 1;
      const meta = [['prompt', JSON.stringify(last ?? {})], ['workflow', '{"nodes":"secret workflow"}']];
      if (state.view === 'jpeg') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, h, 0, w, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])); }
      if (state.view === 'text') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not an image</html>'); }
      if (state.view === 'huge-length') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(200 * 1024 * 1024) }); return res.write(Buffer.alloc(16)); }
      if (state.view === 'wrongdims') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(makePng(w / 2, h / 2, { seed: idx })); }
      if (state.view === 'bomb') { const b = makePng(8, 8); b.writeUInt32BE(100_000, 16); b.writeUInt32BE(100_000, 20); res.writeHead(200, { 'content-type': 'image/png' }); return res.end(b); }
      if (state.view === 'bigmeta') meta.push(['comment', 'm'.repeat(2 * 1024 * 1024)]);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(makePng(w, h, { seed: state.sameBytes ? 0 : idx + Number(last?.['3'].inputs.seed ?? 0) % 7, text: meta }));
    }
    json(404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { state, server, endpoint: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

let n = 0;
function setupEngine({ endpoint, enforce = realEnforce, probeTimeoutMs = 1500, timeoutMs = 10_000, pollIntervalMs = 20 } = {}) {
  const dir = path.join(TMP, `w${++n}`); fs.mkdirSync(dir);
  const store = EetfStore.open({ dbPath: path.join(dir, 'eetf.sqlite'), assetRoot: path.join(dir, 'root') });
  opened.push(store);
  const registry = createProviderRegistry();
  const adapter = createComfyUiProvider({ endpoint, enforce, probeTimeoutMs, requestTimeoutMs: 2000 });
  registry.register(adapter);
  const engine = createEetfGenerationEngine({ store, registry, timeoutMs, pollIntervalMs });
  return { store, registry, adapter, engine };
}
const req = (extra = {}) => ({ prompt: 'mossy cobblestones, top-down texture', width: 64, height: 64, target: 'TEXTURE', textureRole: 'BASE_COLOR', model: MODEL, ...extra });

// ── tests ──────────────────────────────────────────────────────────────────

test('endpoint policy: loopback only (127.0.0.1, ::1, localhost→127.0.0.1); LAN / external / https / credentials refused before any request', async () => {
  assert.equal(parseLoopbackEndpoint('http://127.0.0.1:8188'), 'http://127.0.0.1:8188');
  assert.equal(parseLoopbackEndpoint('http://localhost:8188/'), 'http://127.0.0.1:8188', 'no DNS: localhost is pinned to 127.0.0.1');
  assert.equal(parseLoopbackEndpoint('http://[::1]:8188'), 'http://[::1]:8188');
  const before = fetched.length;
  for (const [ep, expected] of [
    ['http://192.168.1.20:8188', 'REFUSED'], ['http://10.0.0.5:8188', 'REFUSED'], ['http://0.0.0.0:8188', 'REFUSED'], ['http://127.0.0.2:8188', 'REFUSED'],
    ['http://example.com:8188', 'REFUSED'], ['http://localhost.evil.com:8188', 'REFUSED'], ['http://127.0.0.1.nip.io:8188', 'REFUSED'],
    ['https://127.0.0.1:8188', 'REFUSED'], ['https://example.com', 'REFUSED'], ['http://user:pw@127.0.0.1:8188', 'REFUSED'], ['ftp://127.0.0.1', 'REFUSED'],
    ['http://[::ffff:127.0.0.1]:8188', 'REFUSED'], ['not a url', 'MISCONFIGURED'], ['', 'MISCONFIGURED'], ['http://127.0.0.1:8188/api?x=1', 'MISCONFIGURED'],
  ]) {
    const snap = makeProviderSnapshot(await createComfyUiProvider({ endpoint: ep, enforce: realEnforce }).probe());
    assert.equal(snap.status, PROVIDER_STATE[expected], ep);
    assert.deepEqual(snap.capabilities, []);
  }
  assert.equal(fetched.length, before, 'no request for a refused / misconfigured endpoint');
});

test('registry + capability negotiation: verified capabilities only, models / samplers filtered, DEGRADED without checkpoint', async () => {
  const fake = await fakeComfy();
  const { registry } = setupEngine({ endpoint: fake.endpoint });
  assert.deepEqual(registry.list(), ['comfyui']);
  assert.throws(() => registry.register(createComfyUiProvider({ endpoint: fake.endpoint, enforce: realEnforce })), code('EETF_INVALID_PROVIDER'));
  assert.throws(() => registry.register({ providerId: 'cloudy', locality: 'REMOTE', probe() {}, generate() {} }), code('EETF_INVALID_PROVIDER'));
  const snap = await registry.refresh('comfyui');
  assert.equal(snap.status, 'AVAILABLE');
  assert.deepEqual(snap.capabilities, ['CANCELLATION', 'NEGATIVE_PROMPT', 'SEED', 'TXT2IMG']);
  for (const never of ['IMAGE_TO_IMAGE', 'SEAMLESS_TEXTURE', 'PANORAMA_REFERENCE']) assert.ok(!snap.capabilities.includes(never), `${never} is not claimed`);
  assert.deepEqual(snap.models, [MODEL, 'sd15/alt.safetensors'], 'path-like names reported by the engine are dropped');
  assert.match(snap.reason, /2 model name\(s\) refused/);
  assert.deepEqual(snap.samplers, ['euler', 'dpmpp_2m']); assert.deepEqual(snap.schedulers, ['normal', 'karras']);
  assert.equal(snap.limits.vramTotalMb, 8151); assert.equal(snap.health.engineVersion, '0.3.99-fake');
  assert.deepEqual(snap.generationModes, ['TXT2IMG']); assert.equal(snap.kind, 'LOCAL'); assert.equal(snap.locality, 'LOOPBACK');
  fake.state.interruptRoute = false;
  assert.ok(!(await registry.refresh('comfyui')).capabilities.includes('CANCELLATION'), 'CANCELLATION only when /interrupt exists');
  fake.state.models = [];
  const noModel = await registry.refresh('comfyui');
  assert.deepEqual([noModel.status, noModel.capabilities], ['DEGRADED', []]);
  fake.state.models = [MODEL]; fake.state.missingNodes = ['VAEDecode'];
  assert.match((await registry.refresh('comfyui')).reason, /missing nodes: VAEDecode/);
  assert.throws(() => makeProviderSnapshot({ providerId: 'x', status: 'DEGRADED', locality: 'LOOPBACK', capabilities: ['TXT2IMG'] }), code('EETF_INVALID_PROVIDER'));
});

test('unavailable is a normal state: closed port, the real default endpoint (ComfyUI not installed), hang, reset, 500, invalid JSON, oversized, redirect', async () => {
  const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const port = closed.address().port; await new Promise(r => closed.close(r));
  assert.equal((await createComfyUiProvider({ endpoint: `http://127.0.0.1:${port}`, enforce: realEnforce }).probe()).status, 'UNAVAILABLE');
  const real = await createComfyUiProvider({ enforce: realEnforce, probeTimeoutMs: 1500 }).probe();
  assert.equal(real.status, 'UNAVAILABLE', 'the real 127.0.0.1:8188 has no ComfyUI on this machine');
  const sentinel = await fakeComfy();
  for (const [stats, expected] of [['hang', 'UNAVAILABLE'], ['reset', 'UNAVAILABLE'], ['500', 'DEGRADED'], ['badjson', 'DEGRADED'], ['huge', 'DEGRADED'], ['redirect', 'REFUSED']]) {
    const fake = await fakeComfy({ stats, sentinelPort: sentinel.port });
    const t0 = Date.now();
    const s = await createComfyUiProvider({ endpoint: fake.endpoint, enforce: realEnforce, probeTimeoutMs: 400 }).probe();
    assert.equal(s.status, expected, `${stats}: ${s.reason}`);
    assert.ok(Date.now() - t0 < 5000, `${stats} bounded`);
  }
  assert.equal(sentinel.state.log.length, 0, 'a redirect is never followed');
});

test('Root Policy: AI_LOCAL_REQUEST (module ai) before every request; a refusal sends nothing', async () => {
  const fake = await fakeComfy();
  const seen = [];
  const { registry, engine, store } = setupEngine({ endpoint: fake.endpoint, enforce: (r) => { seen.push(r); return realEnforce(r); } });
  await registry.refresh('comfyui');
  assert.equal(seen.length, fake.state.log.length, 'one decision per request');
  assert.ok(seen.every(r => r.action === 'AI_LOCAL_REQUEST' && r.module === 'ai' && r.trustDomain === 'AI' && r.context.networkClass === 'loopback'));
  assert.equal(realEnforce({ action: 'AI_LOCAL_REQUEST', module: 'ai', trustDomain: 'AI', context: {} }).decision, 'ALLOW');
  assert.throws(() => realEnforce({ action: 'AI_LOCAL_REQUEST', module: 'eetf', trustDomain: 'AI', context: {} }), /DENY_UNKNOWN_MODULE/, 'no eetf identity exists');
  const job = await engine.submit(req());
  assert.equal(job.status, 'QUEUED'); assert.equal(store.getJob(job.id).provider, 'comfyui');
  const denied = await fakeComfy();
  const deny = () => { throw Object.assign(new Error('refused'), { code: 'ROOT_POLICY_DENIED', decisionCode: 'DENY_TEST', rootPolicyDenied: true }); };
  const d = setupEngine({ endpoint: denied.endpoint, enforce: deny });
  assert.equal((await d.registry.refresh('comfyui')).status, 'REFUSED');
  await assert.rejects(d.engine.submit(req()), code('EETF_PROVIDER_REFUSED'));
  assert.equal(denied.state.log.length, 0, 'no request reached the engine');
});

test('model allow-list + strict parameter validation + pixel / batch / VRAM guards (PROVISIONAL formula)', async () => {
  const fake = await fakeComfy();
  const { engine } = setupEngine({ endpoint: fake.endpoint });
  const bad = [
    [{ model: 'unknown.safetensors' }, 'EETF_MODEL_NOT_FOUND'],
    [{ model: undefined }, 'EETF_MODEL_NOT_FOUND'],
    [{ model: '../../evil.ckpt' }, 'EETF_INVALID_MODEL'], [{ model: 'C:\\models\\x.ckpt' }, 'EETF_INVALID_MODEL'], [{ model: '\\\\srv\\m.ckpt' }, 'EETF_INVALID_MODEL'], [{ model: '/abs.ckpt' }, 'EETF_INVALID_MODEL'],
    [{ model: 42 }, 'EETF_INVALID_TEXT'],
    [{ workflow: { 1: { class_type: 'ExecuteCode' } } }, 'EETF_UNKNOWN_PARAM'], [{ customNode: 'x' }, 'EETF_UNKNOWN_PARAM'],
    [{ width: Number.NaN }, 'EETF_INVALID_NUMBER'], [{ width: Infinity }, 'EETF_INVALID_NUMBER'], [{ width: -64 }, 'EETF_INVALID_NUMBER'], [{ height: 100_000 }, 'EETF_INVALID_NUMBER'],
    [{ steps: 10_000 }, 'EETF_INVALID_NUMBER'], [{ cfg: Number.POSITIVE_INFINITY }, 'EETF_INVALID_NUMBER'], [{ seed: -1 }, 'EETF_INVALID_NUMBER'],
    [{ prompt: { $where: 'x' } }, 'EETF_INVALID_TEXT'], [{ prompt: 'p'.repeat(5000) }, 'EETF_TEXT_TOO_LONG'],
    [{ batchSize: 5 }, 'EETF_INVALID_NUMBER'], [{ sampler: 'evil_sampler' }, 'EETF_INVALID_PARAMS'], [{ sampler: 'heun' }, 'EETF_WORKFLOW_INVALID'],
    [{ width: 2048, height: 4096 }, 'EETF_INVALID_NUMBER'], [{ width: 100, height: 64 }, 'EETF_WORKFLOW_INVALID'],
    [{ target: 'ENVIRONMENT', textureRole: undefined, environmentType: 'PANORAMA_REFERENCE', width: 512, height: 512 }, 'EETF_WORKFLOW_INVALID'],
    [{ target: 'ENVIRONMENT', textureRole: undefined, environmentType: 'HDRI', width: 1024, height: 512 }, 'EETF_ENVIRONMENT_TYPE_UNSUPPORTED'],
    [{ width: 2048, height: 2048 }, 'EETF_VRAM_GUARD'], [{ width: 1024, height: 1024, batchSize: 2 }, 'EETF_VRAM_GUARD'],
  ];
  for (const [extra, c] of bad) await assert.rejects(engine.submit(req(extra)), code(c), JSON.stringify(extra).slice(0, 80));
  assert.equal(fake.state.log.filter(l => l.path === '/prompt').length, 0, 'nothing refused was submitted');
  assert.deepEqual({ ...vramCheck({ width: 512, height: 512, batchSize: 1 }, 8151) }, { status: 'OK', estimateMb: 3224, vramTotalMb: 8151, formula: '2200 + 1 × 1 × 1024 = 3224 MiB', provisional: true });
  assert.equal(vramCheck({ width: 1024, height: 1024 }, 8151).status, 'OK');
  assert.equal(vramCheck({ width: 512, height: 512 }, null).status, 'VRAM_UNKNOWN');
  assert.equal(C.RESOURCE_LIMITS.vramModelBaselineMb.status, 'PROVISIONAL'); assert.equal(C.RESOURCE_LIMITS.vramRequirement.value, null, 'the measured requirement stays TO_MEASURE');
  const pano = await engine.submit(req({ target: 'ENVIRONMENT', textureRole: undefined, environmentType: 'PANORAMA_REFERENCE', width: 1024, height: 512 }));
  assert.equal(pano.status, 'QUEUED');
  const snap = await setupEngine({ endpoint: fake.endpoint }).registry.refresh('comfyui');
  assert.equal(negotiate(snap, { ...req(), model: 'sd15/alt.safetensors' }).ok, true, 'a subfolder model reported by the engine is selectable');
});

test('workflow whitelist: only the server template is sent; any tampering is refused', async () => {
  const base = { prompt: 'p', negativePrompt: 'n', model: MODEL, width: 64, height: 64, steps: 20, cfg: 7, sampler: 'euler', scheduler: 'normal', seed: 1, batchSize: 1 };
  assert.doesNotThrow(() => validateWorkflow(buildWorkflow(base)));
  const tamper = [
    (w) => { w['10'] = { class_type: 'ExecuteCode', inputs: { code: 'rm -rf /' } }; },
    (w) => { w['9'].class_type = 'SaveImageWebsocket'; },
    (w) => { w['4'].inputs.extra = 1; },
    (w) => { w['3'].inputs.model = ['10', 0]; },
    (w) => { w['9'].inputs.filename_prefix = '../../../evil'; },
    (w) => { w['3'].inputs.sampler_name = 'evil_sampler'; },
    (w) => { w['3'].inputs.denoise = 0.5; },
    (w) => { w['5'].inputs.batch_size = 64; },
    (w) => { w['4'].inputs.ckpt_name = '..\\..\\x.ckpt'; },
    (w) => { w['6'].inputs.text = { injected: true }; },
    (w) => { delete w['8']; },
  ];
  for (const [i, t] of tamper.entries()) { const w = buildWorkflow(base); t(w); assert.throws(() => validateWorkflow(w), (e) => /WORKFLOW_INVALID|INVALID_MODEL/.test(e.code), `tamper ${i}`); }
  assert.equal(typeof createComfyUiProvider({ endpoint: 'http://127.0.0.1:1', enforce: realEnforce }).submitWorkflow, 'undefined', 'no API accepts a caller workflow');
});

test('successful fake generation: batch 2, seed + negative prompt, validated + stripped outputs, provenance, transitions, dedup, existing assets untouched', async () => {
  const fake = await fakeComfy({ pendingPolls: 2 });
  const { engine, store } = setupEngine({ endpoint: fake.endpoint });
  const existing = store.registerAsset({ buffer: makePng(16, 16, { seed: 9 }), declaredMime: 'image/png', role: 'SOURCE' }).asset;
  const existingPath = store.files.resolveAssetPath(existing.storagePath); const existingHash = hashFile(existingPath);
  const job = await engine.submit(req({ negativePrompt: 'blurry', seed: 1234, batchSize: 2 }));
  assert.equal(job.params.seed, 1234); assert.equal(job.params.sampler, 'euler'); assert.equal(job.params.scheduler, 'normal');
  const done = await engine.run(job.id);
  assert.equal(done.status, 'COMPLETED', JSON.stringify(done.error));
  assert.ok(done.startedAt && done.completedAt && done.progress === 1);
  assert.equal(done.outputAssetIds.length, 2);
  for (const id of done.outputAssetIds) {
    const a = store.getAsset(id);
    assert.deepEqual([a.role, a.actualFormat, a.width, a.height, a.dynamicRange, a.sourceJobId], ['GENERATED', 'PNG', 64, 64, 'LDR', job.id]);
    const bytes = fs.readFileSync(store.files.resolveAssetPath(a.storagePath));
    assert.deepEqual(pngChunkTypes(bytes).filter(t => !['IHDR', 'IDAT', 'IEND'].includes(t)), [], 'no prompt / workflow chunk stored');
    assert.equal(bytes.includes(Buffer.from('secret workflow')) || bytes.includes(Buffer.from('mossy')), false);
    const prov = store.getProvenance(a.provenanceId);
    assert.deepEqual([prov.provider, prov.model, prov.prompt, prov.negativePrompt, prov.seed, prov.width, prov.height, prov.engineVersion, prov.strictLocal], ['comfyui', MODEL, req().prompt, 'blurry', 1234, 64, 64, '0.3.99-fake', true]);
    assert.equal(prov.parameters.template, 'eetf-txt2img-v1'); assert.deepEqual(prov.parameters.metadataRemoved, ['tEXt', 'tEXt']);
    assert.equal(prov.parameters.vram.provisional, true);
  }
  const sent = JSON.parse(fake.state.log.find(l => l.path === '/prompt').body).prompt;
  assert.doesNotThrow(() => validateWorkflow(sent));
  assert.deepEqual([sent['3'].inputs.seed, sent['7'].inputs.text, sent['5'].inputs.batch_size, sent['9'].inputs.filename_prefix], [1234, 'blurry', 2, 'eetf']);
  for (const l of fake.state.log) assert.equal(`${l.path}${l.query}`.includes('mossy'), false, 'the prompt never appears in a URL');
  const views = fake.state.log.filter(l => l.path === '/view').map(l => new URL(`http://x${l.path}${l.query}`).searchParams.get('filename'));
  assert.deepEqual(views, ['eetf_00001_.png', 'eetf_00002_.png']);
  // same request again → same bytes → same assets, no new provenance
  const provBefore = store.db.prepare('SELECT COUNT(*) AS n FROM eetf_provenance').get().n;
  const again = await engine.run((await engine.submit(req({ negativePrompt: 'blurry', seed: 1234, batchSize: 2 }))).id);
  assert.deepEqual(again.outputAssetIds, done.outputAssetIds);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM eetf_provenance').get().n, provBefore);
  assert.equal(hashFile(existingPath), existingHash, 'existing assets untouched');
  // a retry keeps the seed (new job, retryOf)
  const failed = store.startJob(store.createJob({ kind: 'GENERATE', params: job.params, provider: 'comfyui', model: MODEL }).id);
  store.failJob(failed.id, { code: 'GENERATION_FAILED' });
  const retry = store.retryJob(failed.id);
  assert.deepEqual([retry.retryOf, retry.params.seed], [failed.id, 1234]);
});

test('outputs are never trusted: malicious references, wrong MIME, HTML, huge length, pixel bomb, wrong size, missing / extra images, engine errors, oversized metadata', async () => {
  const cases = [
    [{ refs: [{ filename: '../../../Windows/win.ini', subfolder: '', type: 'output' }] }, 'OUTPUT_INVALID', true],
    [{ refs: [{ filename: 'C:\\Windows\\x.png', subfolder: '', type: 'output' }] }, 'OUTPUT_INVALID', true],
    [{ refs: [{ filename: 'ok.png', subfolder: '..', type: 'output' }] }, 'OUTPUT_INVALID', true],
    [{ refs: [{ filename: 'ok.png', subfolder: '', type: 'input' }] }, 'OUTPUT_INVALID', true],
    [{ refs: [{ filename: '\\\\srv\\share\\x.png', subfolder: '', type: 'output' }] }, 'OUTPUT_INVALID', true],
    [{ refs: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'output' }, { filename: 'c.png', subfolder: '', type: 'output' }] }, 'OUTPUT_INVALID', true],
    [{ history: 'noimages' }, 'OUTPUT_MISSING', true],
    [{ history: 'error' }, 'GENERATION_FAILED', true],
    [{ history: 'oom' }, 'GENERATION_FAILED', true],
    [{ view: 'jpeg' }, 'OUTPUT_INVALID', false],
    [{ view: 'text' }, 'OUTPUT_INVALID', false],
    [{ view: 'huge-length' }, 'OUTPUT_INVALID', false],
    [{ view: 'bomb' }, 'OUTPUT_INVALID', false],
    [{ view: 'wrongdims' }, 'OUTPUT_INVALID', false],
  ];
  for (const [over, expected, noView] of cases) {
    const fake = await fakeComfy(over);
    const { engine, store } = setupEngine({ endpoint: fake.endpoint });
    const r = await engine.run((await engine.submit(req())).id);
    assert.deepEqual([r.status, r.error?.code], ['FAILED', expected], JSON.stringify(over));
    if (noView) assert.equal(fake.state.log.filter(l => l.path === '/view').length, 0, `${JSON.stringify(over)}: nothing downloaded`);
    if (over.history === 'oom') assert.match(r.error.message, /GPU memory/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE role = 'GENERATED'").get().n, 0);
    assert.equal(fs.readdirSync(path.join(store.files.root, 'tmp')).length, 0);
  }
  const big = await fakeComfy({ view: 'bigmeta' });
  const b = setupEngine({ endpoint: big.endpoint });
  const ok = await b.engine.run((await b.engine.submit(req())).id);
  assert.equal(ok.status, 'COMPLETED');
  assert.ok(b.store.getAsset(ok.outputAssetIds[0]).sizeBytes < 100_000, 'a 2 MB metadata chunk is not stored');
  for (const bad of [{ filename: 'x/y.png' }, { filename: '..png' }, { filename: '.hidden' }, { filename: 'a.png', subfolder: 'sub' }, null, { filename: 'a'.repeat(300) }]) assert.throws(() => validateOutputRef(bad), code('OUTPUT_INVALID'));
});

test('provider failures during generation: /prompt 500, 400 (validation), invalid JSON, connection drop, hang (bounded)', async () => {
  for (const [prompt, expected] of [['500', 'GENERATION_FAILED'], ['400', 'WORKFLOW_INVALID'], ['badjson', 'GENERATION_FAILED'], ['reset', 'PROVIDER_UNAVAILABLE']]) {
    const fake = await fakeComfy({ prompt });
    const { engine } = setupEngine({ endpoint: fake.endpoint });
    const r = await engine.run((await engine.submit(req())).id);
    assert.deepEqual([r.status, r.error.code], ['FAILED', expected], prompt);
  }
  const hang = await fakeComfy({ prompt: 'hang' });
  const h = setupEngine({ endpoint: hang.endpoint, timeoutMs: 500 });
  const t0 = Date.now();
  const r = await h.engine.run((await h.engine.submit(req())).id);
  assert.deepEqual([r.status, r.error.code], ['FAILED', 'PROVIDER_TIMEOUT']);
  assert.ok(Date.now() - t0 < 5000);
  assert.match(r.error.message, /not sent \(no prompt id\)/, 'no blind interrupt without our prompt id');
});

test('timeout: bounded polling, FAILED PROVIDER_TIMEOUT, interrupt of OUR prompt requested, no GPU-stop claim', async () => {
  const fake = await fakeComfy({ pendingPolls: Infinity });
  const { engine } = setupEngine({ endpoint: fake.endpoint, timeoutMs: 300, pollIntervalMs: 50 });
  const r = await engine.run((await engine.submit(req())).id);
  assert.deepEqual([r.status, r.error.code], ['FAILED', 'PROVIDER_TIMEOUT']);
  assert.match(r.error.message, /does not guarantee the GPU stops/);
  assert.ok(fake.state.polls <= Math.ceil(300 / 50) + 1, `polls bounded (${fake.state.polls})`);
  const promptId = JSON.parse(fake.state.log.find(l => l.path === '/queue').body).delete[0];
  assert.equal(JSON.parse(fake.state.log.find(l => l.path === '/interrupt' && l.method === 'POST').body).prompt_id, promptId);
  const after = fake.state.polls; await sleep(200);
  assert.equal(fake.state.polls, after, 'polling stopped');
  // the client itself bounds attempts even without the engine timer
  const c = createComfyUiClient({ endpoint: fake.endpoint, enforce: realEnforce });
  const id = await c.submit(buildWorkflow({ prompt: 'p', model: MODEL, width: 64, height: 64, steps: 1, cfg: 1, sampler: 'euler', scheduler: 'normal', seed: 1, batchSize: 1 }), crypto.randomUUID());
  await assert.rejects(c.pollHistory(id, { intervalMs: 5, maxAttempts: 4, isDone: () => false }), code('PROVIDER_TIMEOUT'));
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(c.pollHistory(id, { intervalMs: 1000, maxAttempts: 100, signal: ctrl.signal, isDone: () => false }), code('ABORTED'));
});

test('cancellation: QUEUED sends nothing; RUNNING aborts polling, interrupts OUR prompt, CANCELLED, gpuStopGuaranteed false', async () => {
  const fake = await fakeComfy({ pendingPolls: Infinity });
  const { engine, store } = setupEngine({ endpoint: fake.endpoint, pollIntervalMs: 30 });
  const q = await engine.submit(req());
  const c1 = await engine.cancel(q.id);
  assert.deepEqual([c1.job.status, c1.interruptRequired, c1.interrupt], ['CANCELLED', false, null]);
  assert.equal(fake.state.log.filter(l => l.path === '/prompt').length, 0);
  const job = await engine.submit(req());
  const running = engine.run(job.id);
  while (!fake.state.log.some(l => l.path.startsWith('/history/'))) await sleep(10);
  const c2 = await engine.cancel(job.id);
  assert.deepEqual([c2.job.status, c2.interruptRequired, c2.gpuStopGuaranteed], ['CANCELLED', true, false]);
  assert.deepEqual({ ...c2.interrupt }, { queueDeleteAccepted: true, interruptAccepted: true });
  assert.match(c2.note, /does not guarantee/);
  const final = await running;
  assert.deepEqual([final.status, final.error.code], ['CANCELLED', 'CANCELLED_BY_USER']);
  const polls = fake.state.polls; await sleep(150);
  assert.equal(fake.state.polls, polls, 'no polling after cancel');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM eetf_assets WHERE role = 'GENERATED'").get().n, 0);
});

test('single GPU slot: a second run is refused while one runs; the engine never has two prompts in flight', async () => {
  const fake = await fakeComfy({ pendingPolls: Infinity });
  const { engine, store } = setupEngine({ endpoint: fake.endpoint, pollIntervalMs: 30 });
  const a = await engine.submit(req()); const b = await engine.submit(req({ seed: 7 }));
  const p = engine.run(a.id);
  while (!fake.state.log.some(l => l.path === '/prompt')) await sleep(10);
  await assert.rejects(engine.run(b.id), code('EETF_ENGINE_BUSY'));
  assert.equal(store.getJob(b.id).status, 'QUEUED');
  assert.equal(fake.state.maxRunning, 1);
  await engine.cancel(a.id); await p;
  fake.state.pendingPolls = 1; // the engine now finishes the next prompt
  const next = await engine.runNext();
  assert.deepEqual([next.id, next.status], [b.id, 'COMPLETED']);
});

test('PNG metadata strip: text / EXIF / time / ICC / private chunks removed, pixels identical, malformed refused', () => {
  const src = makePng(8, 8, { text: [['prompt', 'castle'], ['workflow', '{}']] });
  const withMore = Buffer.concat([src.subarray(0, 33), chunk('eXIf', Buffer.from('MM')), chunk('iCCP', Buffer.from('icc')), chunk('tIME', Buffer.alloc(7)), chunk('prVt', Buffer.from('x')), chunk('gAMA', Buffer.alloc(4)), src.subarray(33)]);
  const { buffer, removed } = stripPngMetadata(withMore);
  assert.deepEqual(pngChunkTypes(buffer), ['IHDR', 'gAMA', 'IDAT', 'IEND']);
  assert.deepEqual(removed.sort(), ['eXIf', 'iCCP', 'prVt', 'tEXt', 'tEXt', 'tIME'].sort());
  const idat = (b) => { let i = 8; while (i < b.length) { const l = b.readUInt32BE(i); if (b.toString('latin1', i + 4, i + 8) === 'IDAT') return b.subarray(i, i + 12 + l); i += 12 + l; } return null; };
  assert.ok(idat(buffer).equals(idat(src)), 'pixel data copied byte for byte');
  const badCrc = Buffer.from(src); badCrc[30] ^= 0xff;
  assert.throws(() => stripPngMetadata(badCrc), code('EETF_MALFORMED_IMAGE'));
  assert.throws(() => stripPngMetadata(src.subarray(0, src.length - 5)), code('EETF_MALFORMED_IMAGE'));
  assert.throws(() => stripPngMetadata(Buffer.from('not a png at all......')), code('EETF_MALFORMED_IMAGE'));
});

test('isolation: loopback only, no cloud, no install / start, no process, user DB unchanged', () => {
  assert.equal(externalAttempts, 0, 'no non-loopback request was even attempted');
  assert.ok(fetched.every(u => /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(u)));
  for (const f of ['eetf-providers.js', 'eetf-comfyui-provider.js', 'eetf-generate.js', 'eetf-image-meta.js', 'providers/comfyui.js']) {
    const src = fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8').replace(/\/\/.*$/gm, '');
    for (const re of [/child_process/, /comfyui-install-manager/, /comfyui-model-manager/, /\bspawn\b/, /safeFetch/, /image-router/, /ollama/i, /https:\/\//]) assert.equal(re.test(src), false, `${f}: ${re}`);
  }
  for (const f of ['eetf-providers.js', 'eetf-comfyui-provider.js', 'eetf-generate.js', 'eetf-image-meta.js']) {
    assert.equal(/(^|[^A-Za-z0-9_.$])fetch\s*\(/m.test(fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8')), false, `${f} has no raw fetch (only the ComfyUI client does)`);
  }
  assert.deepEqual(REAL_DB_FILES.map(fileHash), realDbBefore, 'user database files byte-identical');
  assert.equal(fs.existsSync(path.join(HERE, 'data', 'eetf')), false);
  assert.equal(fs.existsSync(path.join(HERE, 'tools', 'comfyui')), false, 'ComfyUI was not installed');
});
