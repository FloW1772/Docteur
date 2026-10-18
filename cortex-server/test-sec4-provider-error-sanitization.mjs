// SEC-REMED-4 / SEC-4 — provider errors are UNTRUSTED DATA and never reach the client or a persistent log raw.
//
// Root cause (SEC-CERT-RETRY-3): classifyModelError copied up to 300 chars of the upstream error.message into the
// PROVIDER_ERROR message returned by POST /api/model-router/run, and POST /api/chat/message returned, logged and stored
// in the activity log the raw runtime err.message. An upstream echoing the configured credential (or a private path, a
// stack, SQL diagnostics) therefore leaked. Fix: stable code + fixed Docteur text + allowlisted log fields only
// (src/lib/provider-error-contract.js). Codes are unchanged: TIMEOUT ≠ CANCELLED, MODEL_NOT_INSTALLED ≠ PROVIDER_ERROR.
//
// Loopback fakes only (fake Ollama + fake Groq-like upstream on 127.0.0.1), :memory: DB, temporary log file.
// Every credential below is synthetic, generated at run time; none is printed.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSqlite, setRouterSettings, createConversation, getActivityLog } from './src/lib/sqlite.js';
import { createLogger } from './src/lib/logger.js';
import { createOllamaClient } from './src/lib/ollama.js';
import { ErrorCategory, classifiedError } from './src/lib/provider-errors.js';
import { buildRegistry, selectRoute, executeRoute, classifyModelError, collectOllamaInventory } from './src/lib/model-router.js';
import { SAFE_PROVIDER_ERROR_MESSAGE, providerErrorLogFields, providerErrorHint, safeModelTag } from './src/lib/provider-error-contract.js';
import { createChatRoute } from './src/routes/chat.js';
import { createModelRouterRoute } from './src/routes/model-router.js';
import { startFakeOllama, hang } from './fixtures/fake-ollama-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
initSqlite(':memory:');

// ── Synthetic hostile material ────────────────────────────────────────────────
const rnd = (n = 16) => crypto.randomBytes(n).toString('hex');
const SECRETS = {
  canary: `DOCTEUR_SECRET_CANARY_${rnd(8)}`,
  openai: `sk-${'proj'}-${rnd(20)}`,
  anthropic: `sk-${'ant'}-api03-${rnd(20)}`,
  openrouter: `sk-${'or'}-v1-${rnd(24)}`,
  groq: `gsk${'_'}${rnd(20)}`,
  bearer: rnd(18),
  apiKeyParam: rnd(18),
};
const CONFIGURED_GROQ_KEY = `gsk${'_'}${rnd(22)}`; // the "configured" credential the fake upstream echoes back
const FRAGMENTS = {
  privatePath: 'C:\\Users\\victim\\AppData\\secret.txt',
  stack: 'Error: boom\n    at Object.<anonymous> (C:\\Users\\victim\\app\\provider.js:42:13)\n    at Module._compile (node:internal/modules/cjs/loader:1256:14)',
  sql: 'SQLITE_ERROR: no such table: secret_keys (SELECT api_key FROM secret_keys WHERE id = 1)',
  bearer: `Authorization: Bearer ${SECRETS.bearer}`,
  apiKeyParam: `GET /v1/chat?api_key=${SECRETS.apiKeyParam}`,
  tokens: `tokens ${SECRETS.openai} ${SECRETS.anthropic} ${SECRETS.openrouter} ${SECRETS.groq}`,
};
const VARIANTS = {
  canary: `upstream failure ${SECRETS.canary}`,
  openai: `Incorrect API key provided: ${SECRETS.openai}`,
  anthropic: `invalid x-api-key ${SECRETS.anthropic}`,
  openrouter: `No auth credentials found for ${SECRETS.openrouter}`,
  groq: `Invalid API Key ${SECRETS.groq}`,
  bearer: FRAGMENTS.bearer,
  apiKeyParam: FRAGMENTS.apiKeyParam,
  privatePath: `ENOENT: open '${FRAGMENTS.privatePath}'`,
  stack: FRAGMENTS.stack,
  sql: FRAGMENTS.sql,
  multiLine: [SECRETS.canary, FRAGMENTS.privatePath, FRAGMENTS.stack, FRAGMENTS.sql, FRAGMENTS.bearer, FRAGMENTS.apiKeyParam, FRAGMENTS.tokens].join('\n'),
};
// Raw markers that must never appear (secret values + hostile literal fragments).
const MARKERS = [
  ...Object.values(SECRETS), CONFIGURED_GROQ_KEY, 'DOCTEUR_SECRET_CANARY', 'victim', 'AppData', 'secret.txt',
  'at Object.<anonymous>', 'Module._compile', 'node:internal', 'SQLITE_ERROR', 'secret_keys', 'SELECT ', 'Authorization',
  'Bearer', 'api_key=', 'x-api-key', 'sk-', 'gsk_', 'ENOENT', 'upstream failure', 'Incorrect API key',
];
const leaks = (text) => MARKERS.filter(m => String(text).includes(m));
const assertClean = (text, where) => assert.deepEqual(leaks(text), [], `${where}: raw provider material leaked`);
const assertNoErrorInternals = (json, where) => {
  const s = JSON.stringify(json);
  for (const k of ['"stack"', '"cause"', '"detail"', '"body"', '"raw"']) assert.ok(!s.includes(k), `${where}: field ${k} exposed`);
};

// ── Loopback fakes ────────────────────────────────────────────────────────────
const LOCAL_MODEL = 'qwen-local:3b';
let chatBehaviour = () => ({ status: 500, json: { error: VARIANTS.multiLine } });
const servers = [];
const fakeOllama = await startFakeOllama({
  models: [LOCAL_MODEL],
  chat: (body) => (body.keep_alive === 0 ? { json: { message: { role: 'assistant', content: '' }, done: true } } : chatBehaviour(body)),
});
servers.push(fakeOllama);
let upstreamMessage = VARIANTS.multiLine;
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  upstreamHits += 1;
  req.resume();
  req.on('end', () => {
    res.writeHead(400, { 'content-type': 'application/json' });
    // A realistic hostile upstream: echoes the credential it received FIRST (so no truncation can hide it).
    res.end(JSON.stringify({ error: { message: `received ${req.headers.authorization}\n${upstreamMessage}` } }));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.startsWith('https://api.groq.com/')) return realFetch(UPSTREAM_URL + new URL(u).pathname, init);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) throw new Error('test: non-loopback fetch refused');
  return realFetch(url, init);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-sec4-'));
const logFile = path.join(tmp, 'cortex.log');
const logger = createLogger({ level: 'info', logFile });
const client = createOllamaClient(fakeOllama.url);
const SETTINGS = { strict_local_mode: false, cloud_enabled: true, chat_model: LOCAL_MODEL };
setRouterSettings(SETTINGS);
const chatApp = createChatRoute({ ollamaClient: client, env: { EMBEDDING_MODEL: 'absent-embed', LANCEDB_PATH: path.join(tmp, 'lance'), ANSWER_MODEL: 'absent-answer' }, logger });
const routerApp = createModelRouterRoute({ client, getSettings: () => SETTINGS, getKeys: () => ({ groq_key: CONFIGURED_GROQ_KEY }), logger });
const post = async (app, url, body) => { const r = await app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text, json: JSON.parse(text) }; };
createConversation('conv-sec4', '');

after(async () => {
  globalThis.fetch = realFetch;
  for (const s of servers) await s.close();
  await new Promise(r => { upstream.closeAllConnections?.(); upstream.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const readLog = async () => { await new Promise(r => setTimeout(r, 250)); return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''; };

// ── 1. Unit: the classifier reads provider text, never copies it ──────────────

test('classifier: every hostile variant (incl. cause/stack) → fixed message + hint, 0 raw marker', () => {
  for (const [name, text] of Object.entries(VARIANTS)) {
    const err = Object.assign(new Error(text), { cause: new Error(text), stack: text, body: text, response: { data: text } });
    const out = classifyModelError(err, { model: LOCAL_MODEL });
    assert.equal(out.code, 'PROVIDER_ERROR', name);
    assert.equal(out.message, SAFE_PROVIDER_ERROR_MESSAGE, name);
    assertClean(JSON.stringify(out), `classifier ${name}`);
  }
  // A non-Error value thrown by a provider is untrusted too.
  assertClean(JSON.stringify(classifyModelError(VARIANTS.multiLine)), 'classifier string throw');
});

test('classifier: codes are preserved and never collapsed — hostile text inside each class still does not leak', () => {
  const cases = [
    [Object.assign(new Error(`timeout after 1000 ms ${VARIANTS.multiLine}`), { name: 'TimeoutError' }), 'TIMEOUT'],
    [new Error(`connect ECONNREFUSED 127.0.0.1:11434 ${VARIANTS.multiLine}`), 'RUNTIME_UNAVAILABLE'],
    [new Error(`CUDA error: out of memory ${VARIANTS.multiLine}`), 'OUT_OF_MEMORY'],
    [new Error(`model '${LOCAL_MODEL}' not found, try pulling it ${VARIANTS.multiLine}`), 'MODEL_NOT_FOUND'],
    [Object.assign(new Error(VARIANTS.multiLine), { code: 'INVALID_RESPONSE' }), 'INVALID_RESPONSE'],
    [new Error(VARIANTS.multiLine), 'PROVIDER_ERROR'],
  ];
  for (const [err, code] of cases) {
    const out = classifyModelError(err, { model: LOCAL_MODEL });
    assert.equal(out.code, code);
    assertClean(JSON.stringify(out), `classifier ${code}`);
  }
  // A model "name" that is not a model tag is not echoed either.
  assertClean(JSON.stringify(classifyModelError(new Error('x'), { model: VARIANTS.multiLine })), 'classifier hostile model name');
});

test('classifier: provider category picks a fixed hint (closed table); an unknown category falls back to the default', () => {
  const auth = classifyModelError(classifiedError(VARIANTS.groq, ErrorCategory.AUTH_FAILED));
  assert.equal(auth.code, 'PROVIDER_ERROR');
  assert.match(auth.hint, /authentification/);
  assertClean(JSON.stringify(auth), 'auth hint');
  assert.equal(providerErrorHint({ category: VARIANTS.multiLine }), providerErrorHint({}));
  for (const c of Object.values(ErrorCategory)) assertClean(providerErrorHint({ category: c }), `hint ${c}`);
});

test('log fields: allowlisted and bounded only — no message/stack/cause; hostile values become null', () => {
  const err = Object.assign(new Error(VARIANTS.multiLine), { cause: VARIANTS.multiLine, stack: VARIANTS.multiLine, category: ErrorCategory.AUTH_FAILED, status_code: 401 });
  const fields = providerErrorLogFields(err, { errorCode: 'PROVIDER_ERROR', provider: 'groq', model: LOCAL_MODEL, operation: 'model_router.run' });
  assert.deepEqual(Object.keys(fields).sort(), ['category', 'errorCode', 'httpStatus', 'model', 'operation', 'provider']);
  assert.deepEqual(fields, { errorCode: 'PROVIDER_ERROR', provider: 'groq', model: LOCAL_MODEL, operation: 'model_router.run', category: 'AUTH_FAILED', httpStatus: 401 });
  const hostile = providerErrorLogFields({ category: VARIANTS.multiLine, status: VARIANTS.multiLine }, { errorCode: VARIANTS.multiLine, provider: VARIANTS.multiLine, model: VARIANTS.multiLine, operation: VARIANTS.multiLine });
  assert.deepEqual(hostile, { errorCode: 'PROVIDER_ERROR', provider: null, model: null, operation: null, category: null, httpStatus: null });
  assert.equal(safeModelTag(FRAGMENTS.privatePath), null);
});

// ── 2. HTTP: POST /api/chat/message ───────────────────────────────────────────

test('POST /api/chat/message: every hostile runtime error → { ok:false, code, error (fixed), hint }, 0 raw marker in body', async () => {
  for (const [name, text] of Object.entries(VARIANTS)) {
    chatBehaviour = () => ({ status: 500, json: { error: text } });
    const r = await post(chatApp, '/chat/message', { conversationId: 'conv-sec4', message: 'bonjour' });
    assertClean(r.text, `chat ${name}`);
    assertNoErrorInternals(r.json, `chat ${name}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'PROVIDER_ERROR', name);
    assert.equal(r.json.error, `Réponse locale impossible : ${SAFE_PROVIDER_ERROR_MESSAGE}`);
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error', 'hint', 'ok']);
  }
});

test('POST /api/chat/message: MODEL_NOT_INSTALLED stays distinct from PROVIDER_ERROR; runtime 404 → MODEL_NOT_FOUND', async () => {
  setRouterSettings({ ...SETTINGS, chat_model: 'absent-model:1b' });
  try {
    const r = await post(chatApp, '/chat/message', { conversationId: 'conv-sec4', message: 'bonjour' });
    assert.deepEqual([r.json.ok, r.json.model_installed, r.json.code], [false, false, 'MODEL_NOT_INSTALLED']);
  } finally { setRouterSettings(SETTINGS); }
  chatBehaviour = () => ({ status: 404, json: { error: `model '${LOCAL_MODEL}' not found ${VARIANTS.multiLine}` } });
  const nf = await post(chatApp, '/chat/message', { conversationId: 'conv-sec4', message: 'bonjour' });
  assert.equal(nf.json.code, 'MODEL_NOT_FOUND');
  assertClean(nf.text, 'chat 404');
});

// ── 3. HTTP: POST /api/model-router/run (local + cloud) ───────────────────────

test('POST /api/model-router/run (local runtime): every hostile error → 502 { code:PROVIDER_ERROR, fixed message, hint }, 0 raw marker', async () => {
  for (const [name, text] of Object.entries(VARIANTS)) {
    chatBehaviour = () => ({ status: 500, json: { error: text } });
    const r = await post(routerApp, '/model-router/run', { prompt: 'bonjour' });
    assert.equal(r.status, 502, name);
    assertClean(r.text, `router local ${name}`);
    assertNoErrorInternals(r.json, `router local ${name}`);
    assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'hint', 'message']);
    assert.deepEqual([r.json.ok, r.json.error.code, r.json.error.message], [false, 'PROVIDER_ERROR', SAFE_PROVIDER_ERROR_MESSAGE]);
  }
});

test('POST /api/model-router/run (cloud, Groq-like upstream echoing the configured credential): 0 raw marker, configured key never returned', async () => {
  for (const [name, text] of Object.entries(VARIANTS)) {
    upstreamMessage = text;
    const hitsBefore = upstreamHits;
    const r = await post(routerApp, '/model-router/run', { prompt: 'bonjour', mode: 'manual', provider: 'groq', model: 'groq:default' });
    assert.equal(upstreamHits, hitsBefore + 1, `${name}: the hostile upstream was really called`);
    assert.equal(r.status, 502, name);
    assert.ok(!r.text.includes(CONFIGURED_GROQ_KEY), `${name}: configured credential returned`);
    assertClean(r.text, `router cloud ${name}`);
    assertNoErrorInternals(r.json, `router cloud ${name}`);
    assert.equal(r.json.error.code, 'PROVIDER_ERROR');
  }
});

test('MODEL_TIMEOUT ≠ MODEL_CANCELLED ≠ MODEL_NOT_INSTALLED ≠ PROVIDER_ERROR (router codes TIMEOUT / CANCELLED kept)', async () => {
  // MODEL_NOT_INSTALLED: decided before any call.
  const ni = await post(routerApp, '/model-router/run', { prompt: 'x', mode: 'manual', provider: 'ollama', model: 'absent:1b' });
  assert.deepEqual([ni.status, ni.json.error.code], [422, 'MODEL_NOT_INSTALLED']);
  // TIMEOUT over HTTP (no signal on the route: the previous race is kept).
  chatBehaviour = () => hang();
  const to = await post(routerApp, '/model-router/run', { prompt: 'x', timeoutMs: 1_000 });
  assert.deepEqual([to.status, to.json.error.code], [502, 'TIMEOUT']);
  // CANCELLED: the AbortSignal path used by Companion.
  const registry = buildRegistry({ runtime: { reachable: true, installed: [{ name: LOCAL_MODEL, details: {} }], shows: { [LOCAL_MODEL]: { capabilities: ['completion'] } }, loaded: [] }, settings: {} });
  const route = selectRoute(registry, { capabilities: ['TEXT'] });
  const ac = new AbortController();
  const p = executeRoute(route, { messages: [{ role: 'user', content: 'x' }], registry, signal: ac.signal, timeoutMs: 30_000 }, { client });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.code === 'CANCELLED' && e.status === 499);
  const ac2 = new AbortController();
  await assert.rejects(executeRoute(route, { messages: [{ role: 'user', content: 'x' }], registry, signal: ac2.signal, timeoutMs: 1_000 }, { client }), (e) => e.code === 'TIMEOUT');
  chatBehaviour = () => ({ status: 500, json: { error: VARIANTS.multiLine } });
});

test('GET /api/model-router/registry: a hostile runtime inventory error does not reach the provider reason', async () => {
  const hostileClient = { list: async () => { throw new Error(VARIANTS.multiLine); } };
  const inv = await collectOllamaInventory(hostileClient);
  assertClean(JSON.stringify(inv), 'inventory');
  const app = createModelRouterRoute({ client: hostileClient, getSettings: () => ({ strict_local_mode: true }), getKeys: () => ({}), logger });
  const r = await app.request('/model-router/registry');
  assertClean(await r.text(), 'registry');
});

// ── 4. Persistent logs ────────────────────────────────────────────────────────

test('persistent logs: log file and activity log hold codes / allowlisted fields only — 0 raw credential, 0 hostile provider text', async () => {
  const logText = await readLog();
  assert.ok(logText.includes('"errorCode":"PROVIDER_ERROR"'), 'the failures are still logged (safe fields)');
  assert.ok(logText.includes('"operation":"chat.message"') && logText.includes('"operation":"model_router.run"'));
  assertClean(logText, 'log file');
  const activity = getActivityLog({ opType: 'chat_message', limit: 200 });
  const failures = (activity.rows ?? activity.items ?? activity.entries ?? activity).filter?.(e => e.result === 'failure') ?? [];
  assert.ok(failures.length > 0, 'chat failures are recorded in the activity log');
  assertClean(JSON.stringify(activity), 'activity log');
  for (const f of failures) assert.match(String(f.reason), /^[A-Z_]+$/);
});

// ── 5. Static: the boundary files do not copy provider error text ─────────────

test('static: classifyModelError never interpolates the error; chat / model-router routes never return or log err.message', () => {
  const lib = fs.readFileSync(path.join(HERE, 'src/lib/model-router.js'), 'utf8');
  const fn = lib.slice(lib.indexOf('export function classifyModelError'), lib.indexOf('\n}\n', lib.indexOf('export function classifyModelError')));
  assert.ok(fn.length > 100);
  // The raw text may be READ (classification); the returned objects never carry it. The only passthrough is a
  // ModelRouteError, whose message Docteur itself wrote.
  const returns = fn.split('\n').filter(l => /return \{/.test(l) && !/instanceof ModelRouteError/.test(l));
  assert.ok(returns.length >= 6);
  for (const l of returns) {
    assert.doesNotMatch(l, /\$\{[^}]*error/, 'no error value inside a returned template');
    assert.doesNotMatch(l, /message:\s*(String\()?error/, 'no error.message as the client message');
  }
  const routeSrc = fs.readFileSync(path.join(HERE, 'src/routes/model-router.js'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(routeSrc, /err\??\.(stack|cause)/);
  // err.message is returned only for a ModelRouteError (Docteur-written via classifyModelError), never logged.
  const msgLines = routeSrc.split('\n').filter(l => /err\??\.message/.test(l));
  assert.equal(msgLines.length, 1);
  assert.match(msgLines[0], /return c\.json\(\{ ok: false, error: \{ code: err\.code, message: err\.message/);
  assert.match(routeSrc, /if \(err instanceof ModelRouteError\) \{\n[^\n]*\n\s*return c\.json\(\{ ok: false, error: \{ code: err\.code, message: err\.message/);
  for (const l of routeSrc.split('\n').filter(x => /logger/.test(x))) assert.doesNotMatch(l, /err\??\.message|\{ err\b/);
  const chatSrc = fs.readFileSync(path.join(HERE, 'src/routes/chat.js'), 'utf8');
  const handler = chatSrc.slice(chatSrc.indexOf("app.post('/chat/message'"), chatSrc.indexOf('// ── Preference facts'));
  assert.ok(handler.length > 100);
  assert.doesNotMatch(handler, /err\??\.(message|stack|cause)/);
});
