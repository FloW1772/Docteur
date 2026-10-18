// Model Router V1 — COMP-4 / D2 additive change: optional AbortSignal on executeRoute, timeout that really aborts the
// local request, effective model / usage metadata, malformed answers. Backward compatibility: callers without a signal
// keep the exact previous request and behaviour (the original suite test-model-router.mjs is unchanged and still runs).
// The real ollama-js client talks to a fake runtime on 127.0.0.1 only.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, selectRoute, executeRoute } from './src/lib/model-router.js';
import { createOllamaClient, chatCompletion, chatCompletionDetailed, bindRequestSignal } from './src/lib/ollama.js';
import { startFakeOllama, hang } from './fixtures/fake-ollama-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const servers = [];
after(async () => { for (const s of servers) await s.close(); });
const start = async (opts) => { const s = await startFakeOllama(opts); servers.push(s); return s; };
const runtime = (name = 'qwen-local:3b') => ({ reachable: true, installed: [{ name, details: {} }], shows: { [name]: { capabilities: ['completion'] } }, loaded: [] });
const reg = () => buildRegistry({ runtime: runtime(), settings: {} });
const route = () => selectRoute(reg(), { capabilities: ['TEXT'] });
const fakeClient = (behaviour) => { const calls = []; return { calls, chat: async (req) => { calls.push(req); return behaviour(req); } }; };

test('backward compatibility: no signal → same request body as before, same result keys + additive metadata (null when unknown)', async () => {
  const client = fakeClient(() => ({ message: { content: 'Bonjour.' } }));
  const out = await executeRoute(route(), { messages: [{ role: 'user', content: 'Salut' }], registry: reg() }, { client });
  assert.deepEqual(Object.keys(client.calls[0]).sort(), ['keep_alive', 'messages', 'model', 'options', 'stream']);
  assert.deepEqual([client.calls[0].stream, client.calls[0].keep_alive, client.calls[0].options.temperature, 'signal' in client.calls[0]], [false, '15m', 0.2, false]);
  for (const k of ['text', 'json', 'provider', 'model', 'location', 'durationMs']) assert.ok(k in out, k);
  assert.deepEqual([out.requestedModel, out.effectiveProvider, out.effectiveModel, out.abortPropagated], ['qwen-local:3b', 'ollama', null, null]);
  assert.deepEqual(out.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  // the original chatCompletion is unchanged and still exported
  const c2 = fakeClient(() => ({ message: { content: 'x' } }));
  assert.equal(await chatCompletion(c2, 'm', []), 'x');
  const c3 = fakeClient(() => ({ message: { content: 'x' } }));
  await chatCompletionDetailed(c3, 'm', []);
  assert.deepEqual(c2.calls[0], c3.calls[0], 'chatCompletionDetailed sends exactly the chatCompletion request');
});

test('signal: abort before → CANCELLED with 0 call; invalid signal refused; abort during → the real HTTP request is aborted (server sees it)', async () => {
  const client = fakeClient(() => ({ message: { content: 'x' } }));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(executeRoute(route(), { messages: [], registry: reg(), signal: ac.signal }, { client }), (e) => e.code === 'CANCELLED' && e.status === 499);
  assert.equal(client.calls.length, 0);
  await assert.rejects(executeRoute(route(), { messages: [], registry: reg(), signal: { aborted: 'no' } }, { client }), (e) => e.code === 'INVALID_REQUEST');
  let begun;
  const started = new Promise(r => { begun = r; });
  const srv = await start({ chat: () => { begun(); return hang(); } });
  const ac2 = new AbortController();
  const p = executeRoute(route(), { messages: [{ role: 'user', content: 'x' }], registry: reg(), signal: ac2.signal, timeoutMs: 30_000 }, { client: createOllamaClient(srv.url) });
  await started; ac2.abort();
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(srv.state.abortedChats, 1);
});

test('timeout with a signal really aborts the request (TIMEOUT); without a signal the previous race is kept (TIMEOUT too)', async () => {
  const srv = await start({ chat: () => hang() });
  const ac = new AbortController();
  await assert.rejects(executeRoute(route(), { messages: [], registry: reg(), signal: ac.signal, timeoutMs: 1_000 }, { client: createOllamaClient(srv.url) }), (e) => e.code === 'TIMEOUT');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(srv.state.abortedChats, 1, 'no orphan generation left running');
  await assert.rejects(executeRoute(route(), { messages: [], registry: reg(), timeoutMs: 1_000 }, { client: fakeClient(() => new Promise(() => {})) }), (e) => e.code === 'TIMEOUT');
});

test('late result after abort is ignored; abort after the result keeps the success; non-abortable double reports abortPropagated false', async () => {
  const late = fakeClient(async () => { await new Promise(r => setTimeout(r, 200)); return { model: 'qwen-local:3b', message: { content: 'tard' } }; });
  const ac = new AbortController();
  const p = executeRoute(route(), { messages: [], registry: reg(), signal: ac.signal }, { client: late });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.deepEqual(bindRequestSignal(late, ac.signal), { target: late, abortPropagated: false });
  const ok = fakeClient(() => ({ model: 'qwen-local:3b', message: { content: 'ok' }, prompt_eval_count: 5, eval_count: 2 }));
  const ac2 = new AbortController();
  const out = await executeRoute(route(), { messages: [], registry: reg(), signal: ac2.signal }, { client: ok });
  ac2.abort();
  assert.deepEqual([out.text, out.effectiveModel, out.usage.totalTokens, out.abortPropagated], ['ok', 'qwen-local:3b', 7, false]);
});

test('real client on loopback: effective model and token counts from the runtime; non-text content → INVALID_RESPONSE; cloud route keeps working with a signal', async () => {
  const srv = await start({ chat: (b) => ({ json: { model: `${b.model}-q4`, message: { role: 'assistant', content: 'salut' }, done: true, prompt_eval_count: 11, eval_count: 4 } }) });
  const ac = new AbortController();
  const out = await executeRoute(route(), { messages: [{ role: 'user', content: 'x' }], registry: reg(), signal: ac.signal }, { client: createOllamaClient(srv.url) });
  assert.deepEqual([out.requestedModel, out.effectiveModel, out.model, out.abortPropagated], ['qwen-local:3b', 'qwen-local:3b-q4', 'qwen-local:3b', true], '`model` keeps its historical meaning (the decided model); effectiveModel is what ran');
  assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 4, totalTokens: 15 });
  await assert.rejects(executeRoute(route(), { messages: [], registry: reg() }, { client: fakeClient(() => ({ message: { content: { a: 1 } } })) }), (e) => e.code === 'INVALID_RESPONSE');
  const cloudReg = buildRegistry({ runtime: runtime(), settings: { cloud_enabled: true }, cloud: [{ providerId: 'groq' }] });
  const cloudRoute = selectRoute(cloudReg, { mode: 'manual', provider: 'groq', model: 'groq:default', settings: { cloud_enabled: true } });
  const viaCloud = await executeRoute(cloudRoute, { messages: [], signal: new AbortController().signal }, { cloudCall: async () => ({ text: 'c', model: 'llama-3.1-8b' }) });
  assert.deepEqual([viaCloud.text, viaCloud.effectiveModel, viaCloud.abortPropagated], ['c', 'llama-3.1-8b', false]);
});

test('static: still no network / process / download of its own in model-router.js; the scoped fetch lives in ollama.js', () => {
  const lib = fs.readFileSync(path.join(HERE, 'src/lib/model-router.js'), 'utf8');
  assert.doesNotMatch(lib, /\.pull\(|\/api\/pull|\.create\(|child_process|\bspawn\(|\bexec\(|\bfetch\(/);
  assert.match(lib, /import \{ chatCompletionDetailed \} from '\.\/ollama\.js'/);
  const ollama = fs.readFileSync(path.join(HERE, 'src/lib/ollama.js'), 'utf8');
  assert.doesNotMatch(ollama, /\.pull\(|\/api\/pull|child_process|\bspawn\(/);
});
