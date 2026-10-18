// SEC-REMED-4B — global error boundaries: an error's TEXT is untrusted unless Docteur wrote it for the client.
//
// SEC-REMED-4 closed the provider-error relay on POST /api/chat/message and POST /api/model-router/run. The same class
// remained on POST /api/answer (raw runtime text returned, thrown and stored in activity_log / router_logs), app.onError
// (raw Error message, only `key=` stripped), POST /api/compare (raw text in SSE error events), POST /api/vision/analyze
// ("Erreur Ollama : <raw>" + raw activity reason), POST /api/voice/transcribe and POST /api/capture/whisper (raw
// subprocess / Groq text), the legacy router (raw err.message logged; "Tous les modèles ont échoué. Détails: <raw>"
// thrown upward) and POST /api/router/test/:provider (regex-redacted raw provider text).
// Contract under test: src/lib/safe-error-contract.js (+ provider-error-contract.js / classifyModelError, reused).
//
// Loopback fakes only (fake Ollama runtimes + a fake Groq-like upstream on 127.0.0.1), :memory: DB for the in-process
// part, temporary DB / LanceDB / log for the real boot (net spy blocks every non-loopback attempt). Every credential
// below is synthetic, generated at run time; none is printed.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import Database from 'better-sqlite3';
import { initSqlite, getActivityLog, setCloudKey, setRouterSettings } from './src/lib/sqlite.js';
import { createLogger } from './src/lib/logger.js';
import { createOllamaClient } from './src/lib/ollama.js';
import {
  PublicError, isPublicError, toSafePublicError, publicErrorBody, publicErrorMessage, safeErrorLogFields, safeErrorReason,
  createSafeErrorHandler, SAFE_INTERNAL_ERROR_MESSAGE, SAFE_RUNTIME_UNAVAILABLE_MESSAGE,
} from './src/lib/safe-error-contract.js';
import { createAnswerRoute } from './src/routes/answer.js';
import { createCompareRoute } from './src/routes/compare.js';
import { createVisionRoute } from './src/routes/vision.js';
import { createVoiceRoute } from './src/routes/voice.js';
import { createCaptureRoute } from './src/routes/capture.js';
import { createRouterRoute } from './src/routes/router.js';
import { createCyberAuditRoute } from './src/routes/cyber-audit.js';
import { CyberAuditPolicyError } from './src/lib/cyber-policy.js';
import { routedCompletion, tryCloudFallbackChain, runAiTask } from './src/lib/router.js';
import { getImagePath } from './src/lib/image.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = path.join(HERE, 'data', 'cortex.sqlite');
const sha256File = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const REAL_DB_HASH_BEFORE = sha256File(REAL_DB);
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
  sql: 'SQLITE_ERROR: no such table: secrets (SELECT api_key FROM secrets WHERE id = 1)',
  bearer: `Authorization: Bearer ${SECRETS.bearer}`,
  apiKeyParam: `GET /v1/chat?api_key=${SECRETS.apiKeyParam}`,
  tokens: `tokens ${SECRETS.openai} ${SECRETS.anthropic} ${SECRETS.openrouter} ${SECRETS.groq}`,
};
const HOSTILE = [`upstream failure ${SECRETS.canary}`, FRAGMENTS.privatePath, FRAGMENTS.stack, FRAGMENTS.sql, FRAGMENTS.bearer, FRAGMENTS.apiKeyParam, FRAGMENTS.tokens].join('\n');
/** A thrown value carrying the hostile text everywhere an error can carry text (message, stack, cause chain, body). */
const hostileError = (prefix = '') => {
  const nested = new Error(HOSTILE);
  const cause = new Error(HOSTILE, { cause: nested });
  return Object.assign(new Error(`${prefix}${HOSTILE}`, { cause }), { stack: HOSTILE, body: HOSTILE, response: { data: HOSTILE }, code: SECRETS.canary.toUpperCase() });
};
// HTTP bodies / SSE events: nothing of the hostile material may appear.
const MARKERS = [
  ...Object.values(SECRETS), CONFIGURED_GROQ_KEY, 'DOCTEUR_SECRET_CANARY', 'victim', 'AppData', 'secret.txt',
  'at Object.<anonymous>', 'Module._compile', 'node:internal', 'SQLITE_ERROR', 'no such table', 'SELECT ', 'Authorization',
  'Bearer', 'api_key=', 'sk-', 'gsk_', 'upstream failure',
];
// Logs / persistent stores: the secret-bearing hostile fragments (generic words such as "Bearer" can legitimately be
// logged by unrelated boot lines, the synthetic VALUES cannot).
const STORE_MARKERS = [
  ...Object.values(SECRETS), CONFIGURED_GROQ_KEY, 'DOCTEUR_SECRET_CANARY', 'docteur_secret_canary', 'victim', 'secret.txt', 'at Object.<anonymous>',
  'Module._compile', 'no such table: secrets', 'FROM secrets', 'upstream failure',
];
const leaks = (text, markers = MARKERS) => markers.filter(m => String(text).includes(m));
const assertClean = (text, where, markers = MARKERS) => assert.deepEqual(leaks(text, markers), [], `${where}: raw external error material leaked`);
const assertNoErrorInternals = (json, where) => {
  const s = JSON.stringify(json);
  for (const k of ['"stack"', '"cause"', '"body"', '"raw"', '"stderr"']) assert.ok(!s.includes(k), `${where}: field ${k} exposed`);
};

// ── Shared in-process plumbing ────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-sec4b-'));
const logFile = path.join(tmp, 'cortex.log');
const logger = createLogger({ level: 'info', logFile });
const readLog = async (file = logFile) => { await new Promise(r => setTimeout(r, 250)); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; };
const servers = [];
const json = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };

/** Hostile fake Ollama (in-process tests and real boot): tags/show/embed work, every generation fails with HOSTILE. */
async function startHostileOllama({ models, chatError = () => HOSTILE } = {}) {
  const state = { chats: 0, paths: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.paths.push(`${req.method} ${req.url}`);
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (req.url === '/api/tags') return json(res, 200, { models: models.map(name => ({ name, model: name, size: 2e9, details: { family: 'llama', parameter_size: '3B' } })) });
      if (req.url === '/api/version') return json(res, 200, { version: '0.0.0-test' });
      if (req.url === '/api/ps') return json(res, 200, { models: [] });
      if (req.url === '/api/show') return json(res, 200, { capabilities: ['completion'], model_info: { 'llama.context_length': 8192 }, details: { family: 'llama' } });
      if (req.url === '/api/embed') return json(res, 200, { embeddings: [new Array(768).fill(0).map((_, i) => (i % 7) / 7)] });
      if (req.url === '/api/chat' || req.url === '/api/generate') {
        const last = Array.isArray(body.messages) ? body.messages.at(-1)?.content : undefined;
        if (last === '' || last === 'warmup') return json(res, 200, { message: { role: 'assistant', content: '' }, done: true }); // unload / re-warm
        state.chats += 1;
        return json(res, 500, { error: chatError(body) });
      }
      return json(res, 404, { error: 'not found' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const handle = { state, port, url: `http://127.0.0.1:${port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
  servers.push(handle);
  return handle;
}

/** Hostile Groq-like upstream: echoes the credential it received FIRST, then the hostile text. */
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  upstreamHits += 1;
  req.resume();
  req.on('end', () => json(res, 401, { error: { message: `received ${req.headers.authorization}\n${HOSTILE}`, code: SECRETS.canary } }));
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.startsWith('https://api.groq.com/')) { const p = new URL(u); return realFetch(UPSTREAM_URL + p.pathname + p.search, init); }
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return Promise.reject(new Error('test: non-loopback fetch refused'));
  return realFetch(url, init);
};

after(async () => {
  globalThis.fetch = realFetch;
  for (const s of servers) await s.close();
  await new Promise(r => { upstream.closeAllConnections?.(); upstream.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const req = async (app, url, { method = 'POST', body, headers = {} } = {}) => {
  const init = { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await app.request(url, init);
  const text = await r.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, text, json: parsed };
};
const sseEvents = (text) => text.split('\n\n').map(b => b.trim()).filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)));

// ── 1. Unit: the shared contract ──────────────────────────────────────────────

test('contract: PublicError is the only error whose message/code/status cross the boundary; everything else → fixed text', () => {
  const pub = new PublicError('NEURON_NOT_FOUND', 'Neurone introuvable.', { status: 404, hint: 'Vérifiez l’identifiant.' });
  assert.ok(isPublicError(pub));
  assert.deepEqual(toSafePublicError(pub), { status: 404, code: 'NEURON_NOT_FOUND', message: 'Neurone introuvable.', hint: 'Vérifiez l’identifiant.' });
  assert.equal(publicErrorMessage(pub, 'x'), 'Neurone introuvable.');
  // A forged "trusted-looking" error (same name, code, status, even an `expose` flag) is still untrusted.
  const forged = Object.assign(hostileError(), { name: 'PublicError', status: 404, expose: true, hint: HOSTILE });
  assert.equal(isPublicError(forged), false);
  for (const thrown of [hostileError(), HOSTILE, { message: HOSTILE, code: 'NEURON_NOT_FOUND' }, null, undefined, 42, forged]) {
    const out = toSafePublicError(thrown);
    assert.deepEqual(out, { status: 500, code: 'INTERNAL_ERROR', message: SAFE_INTERNAL_ERROR_MESSAGE, hint: null });
    assertClean(JSON.stringify(publicErrorBody(thrown, { code: 'COMPARE_FAILED', message: 'Comparaison impossible.', status: 502 })), 'publicErrorBody');
    assert.equal(publicErrorMessage(thrown, 'Échec.'), 'Échec.');
  }
  // A hostile code / status passed to PublicError never escapes its closed shape.
  const bad = new PublicError(HOSTILE, 'Texte Docteur.', { status: 200, hint: { x: HOSTILE } });
  assert.deepEqual([bad.code, bad.status, bad.hint], ['APPLICATION_ERROR', 400, null]);
  assert.equal(safeErrorReason(hostileError(), 'ANSWER_FAILED'), 'ANSWER_FAILED');
  assert.equal(safeErrorReason(hostileError(), HOSTILE), 'INTERNAL_ERROR');
  assert.equal(safeErrorReason(pub), 'NEURON_NOT_FOUND');
});

test('contract: log fields are allowlisted and bounded — no message/stack/cause/body; hostile code/status/category → null', () => {
  const fields = safeErrorLogFields(hostileError(), { errorCode: 'ANSWER_FAILED', operation: 'answer.question' });
  assert.deepEqual(Object.keys(fields).sort(), ['category', 'errorClass', 'errorCode', 'httpStatus', 'operation', 'sysCode']);
  assert.deepEqual(fields, { errorCode: 'ANSWER_FAILED', errorClass: 'Error', sysCode: null, operation: 'answer.question', category: null, httpStatus: null });
  const hostile = safeErrorLogFields({ category: HOSTILE, status: HOSTILE, code: HOSTILE, constructor: { name: HOSTILE } }, { errorCode: HOSTILE, operation: HOSTILE });
  assert.deepEqual(hostile, { errorCode: 'UNCLASSIFIED_ERROR', errorClass: null, sysCode: null, operation: null, category: null, httpStatus: null });
  assert.equal(safeErrorLogFields(Object.assign(new Error(HOSTILE), { code: 'ECONNREFUSED' })).sysCode, 'ECONNREFUSED');
  assert.equal(safeErrorLogFields(Object.assign(new Error(HOSTILE), { code: 'SQLITE_ERROR' })).sysCode, null);
  assertClean(JSON.stringify(fields), 'log fields');
});

test('global app.onError (createSafeErrorHandler): unknown → 500 INTERNAL_ERROR, runtime down → 503, PublicError / HTTPException / explicit 4xx kept', async () => {
  const app = new Hono();
  app.get('/throw', () => { throw hostileError(); });
  // Hono hands only Error instances to onError (a non-Error throw becomes @hono/node-server's empty-body 500): the
  // handler is still checked directly against such values.
  const direct = createSafeErrorHandler({ logger });
  app.get('/throw-string', (c) => direct(HOSTILE, c));
  app.get('/throw-object', (c) => direct({ message: HOSTILE, stack: HOSTILE, cause: HOSTILE }, c));
  app.get('/throw-null', (c) => direct(null, c));
  app.get('/throw-runtime', () => { throw hostileError('fetch failed ECONNREFUSED '); });
  app.get('/throw-public', () => { throw new PublicError('NEURON_NOT_FOUND', 'Neurone introuvable.', { status: 404 }); });
  app.get('/throw-http', () => { throw new HTTPException(413, { message: 'Contenu trop volumineux' }); });
  app.get('/explicit-409', (c) => c.json({ error: 'Conflit de version', code: 'CONFLICT' }, 409));
  app.post('/json', async (c) => c.json(await c.req.json())); // malformed JSON → SyntaxError whose message echoes the body
  app.onError(createSafeErrorHandler({ logger, isRuntimeUnavailable: (e) => /ECONNREFUSED|fetch failed/.test(String(e?.message)) }));
  const app2 = new Hono();
  app2.get('/throw', () => { throw hostileError('fetch failed '); });
  app2.onError(createSafeErrorHandler({ logger, isRuntimeUnavailable: () => { throw new Error(HOSTILE); } }));

  for (const p of ['/throw', '/throw-string', '/throw-object', '/throw-null']) {
    const r = await req(app, p, { method: 'GET' });
    assert.deepEqual([r.status, r.json], [500, { error: SAFE_INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR' }], p);
    assertClean(r.text, p);
  }
  const rt = await req(app, '/throw-runtime', { method: 'GET' });
  assert.deepEqual([rt.status, rt.json], [503, { error: SAFE_RUNTIME_UNAVAILABLE_MESSAGE, code: 'MODEL_RUNTIME_UNAVAILABLE' }]);
  const pub = await req(app, '/throw-public', { method: 'GET' });
  assert.deepEqual([pub.status, pub.json], [404, { error: 'Neurone introuvable.', code: 'NEURON_NOT_FOUND' }]);
  const he = await req(app, '/throw-http', { method: 'GET' });
  assert.deepEqual([he.status, he.text], [413, 'Contenu trop volumineux']);
  const ex = await req(app, '/explicit-409', { method: 'GET' });
  assert.deepEqual([ex.status, ex.json], [409, { error: 'Conflit de version', code: 'CONFLICT' }]);
  const mj = await req(app, '/json', { body: `{"x": "${SECRETS.canary} ${FRAGMENTS.bearer}"` });
  assert.equal(mj.status, 500);
  assertClean(mj.text, 'malformed JSON');
  const p2 = await req(app2, '/throw', { method: 'GET' });
  assert.deepEqual([p2.status, p2.json.code], [500, 'INTERNAL_ERROR'], 'a failing predicate never turns into a leak');
  assertClean(await readLog(), 'onError log', STORE_MARKERS);
});

// ── 2. Route boundaries (in-process) ──────────────────────────────────────────

test('POST /api/answer route: a hostile thrown error → fixed text + code; runtime down stays 503; PublicError kept; validation 400 kept', async () => {
  let thrower = () => { throw hostileError(); };
  const services = { answerModel: 'm', answerQuestion: async () => thrower(), isOllamaError: (e) => /ECONNREFUSED/.test(String(e?.message)) };
  const app = new Hono(); app.route('/api', createAnswerRoute({ services, logger }));
  const r = await req(app, '/api/answer', { body: { question: 'q' } });
  assert.equal(r.status, 500); assertClean(r.text, 'answer route'); assertNoErrorInternals(r.json, 'answer route');
  assert.equal(typeof r.json.error, 'string'); assert.equal(r.json.code, 'ANSWER_FAILED');
  thrower = () => { throw hostileError('connect ECONNREFUSED '); };
  const d = await req(app, '/api/answer', { body: { question: 'q' } });
  assert.deepEqual([d.status, d.json.code], [503, 'MODEL_RUNTIME_UNAVAILABLE']); assertClean(d.text, 'answer route 503');
  thrower = () => { throw new PublicError('LOCAL_MODEL_FAILED', 'Réponse locale impossible : le modèle local n’a pas répondu.', { status: 503 }); };
  const p = await req(app, '/api/answer', { body: { question: 'q' } });
  assert.deepEqual([p.status, p.json.code, p.json.error], [503, 'LOCAL_MODEL_FAILED', 'Réponse locale impossible : le modèle local n’a pas répondu.']);
  const v = await req(app, '/api/answer', { body: {} });
  assert.deepEqual([v.status, v.json.error], [400, 'Payload invalide. Champ requis: question.']);
});

test('POST /api/compare route: a hostile failure of the whole comparison → SSE error event with fixed text + code', async () => {
  const services = { compareModels: async ({ onEvent }) => { await onEvent({ type: 'ready' }); throw hostileError(); } };
  const app = new Hono(); app.route('/api', createCompareRoute({ services }));
  const r = await req(app, '/api/compare', { body: { question: 'q', models: ['m'] } });
  assertClean(r.text, 'compare route');
  const err = sseEvents(r.text).find(e => e.type === 'error');
  assert.ok(err); assert.equal(err.code, 'COMPARE_FAILED'); assert.equal(typeof err.error, 'string');
  assert.deepEqual(sseEvents(r.text).at(-1), { type: 'done' });
});

test('POST /api/vision/analyze: hostile runtime error → fixed text, activity reason = code, log clean; memory / not-installed stay distinct', async () => {
  const fake = await startHostileOllama({ models: ['llava:7b', 'llama3.2:3b'] });
  const client = createOllamaClient(fake.url);
  const app = new Hono(); app.route('/api', createVisionRoute({ ollamaClient: client, env: { ANSWER_MODEL: 'llama3.2:3b' }, logger }));
  const imageId = `${crypto.randomUUID()}.png`;
  const imagePath = getImagePath(imageId);
  const realExists = fs.existsSync; const realRead = fs.readFileSync;
  fs.existsSync = (p) => (p === imagePath ? true : realExists(p));
  fs.readFileSync = (p, ...a) => (p === imagePath ? Buffer.from('fake-png') : realRead(p, ...a)); // nothing is written to data/images
  try {
    const r = await req(app, '/api/vision/analyze', { body: { imageId, question: 'que vois-tu ?' } });
    assert.ok(fake.state.chats >= 1, 'the hostile runtime was really called');
    assertClean(r.text, 'vision'); assertNoErrorInternals(r.json, 'vision');
    assert.deepEqual([r.json.ok, r.json.fallback_suggested, r.json.code], [false, true, 'PROVIDER_ERROR']);
    assert.match(r.json.error, /Utilisez l'OCR à la place\.$/);
    const oomFake = await startHostileOllama({ models: ['llava:7b'], chatError: () => `CUDA error: out of memory ${HOSTILE}` });
    const app2 = new Hono(); app2.route('/api', createVisionRoute({ ollamaClient: createOllamaClient(oomFake.url), env: { ANSWER_MODEL: 'llama3.2:3b' }, logger }));
    const m = await req(app2, '/api/vision/analyze', { body: { imageId, question: 'q' } });
    assert.equal(m.json.code, 'OUT_OF_MEMORY'); assert.match(m.json.error, /^Mémoire GPU insuffisante/); assertClean(m.text, 'vision oom');
  } finally { fs.existsSync = realExists; fs.readFileSync = realRead; }
  const noModel = await startHostileOllama({ models: ['llama3.2:3b'] });
  const app3 = new Hono(); app3.route('/api', createVisionRoute({ ollamaClient: createOllamaClient(noModel.url), env: { ANSWER_MODEL: 'llama3.2:3b' }, logger }));
  const ni = await req(app3, '/api/vision/analyze', { body: { imageId, question: 'q' } });
  assert.deepEqual([ni.json.ok, ni.json.model_installed], [false, false]);
  const bad = await req(app3, '/api/vision/analyze', { body: { imageId: '../x', question: 'q' } });
  assert.deepEqual([bad.status, bad.json.error], [400, 'Image invalide']);
  const rows = getActivityLog({ opType: 'vision_analyze', limit: 50 }).rows;
  assert.ok(rows.some(x => x.result === 'failure'));
  assertClean(JSON.stringify(rows), 'vision activity log', STORE_MARKERS);
  for (const row of rows.filter(x => x.result === 'failure')) assert.match(String(row.reason), /^[A-Za-z_]+$/);
});

test('POST /api/voice/transcribe: a hostile subprocess (whisper stderr) error → 500 fixed text + code, nothing raw logged', async () => {
  const voiceTmp = fs.mkdtempSync(path.join(tmp, 'voice-'));
  const app = new Hono();
  app.route('/api', createVoiceRoute({ logger, deps: { tmpDir: voiceTmp, transcribeAudioFile: async () => { throw hostileError('Traceback (most recent call last):\n'); } } }));
  const fd = new FormData(); fd.append('audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/webm' }), 'a.webm'); fd.append('provider', 'local');
  const r = await app.request('/api/voice/transcribe', { method: 'POST', body: fd });
  const text = await r.text();
  assert.equal(r.status, 500); assertClean(text, 'voice');
  assert.deepEqual(JSON.parse(text), { error: 'Transcription échouée.', code: 'TRANSCRIPTION_FAILED' });
  assert.deepEqual(fs.readdirSync(voiceTmp), [], 'temporary audio removed');
});

test('POST /api/capture/whisper (SSE): hostile service result / thrown error → fixed text + code; abort stays silent', async () => {
  let behaviour = async () => ({ fallback: true, reason: 'whisper_failed', error: HOSTILE });
  const services = { deepCaptureWhisper: (...a) => behaviour(...a) };
  const app = new Hono(); app.route('/api', createCaptureRoute({ services, logger }));
  const a = await req(app, '/api/capture/whisper', { body: { url: 'https://example.invalid/v' } });
  assertClean(a.text, 'whisper fallback');
  assert.deepEqual(sseEvents(a.text).at(-1), { error: 'La transcription a échoué.', code: 'WHISPER_FAILED' });
  behaviour = async () => ({ fallback: true, reason: 'analysis_failed', error: HOSTILE });
  const b = await req(app, '/api/capture/whisper', { body: { url: 'https://example.invalid/v' } });
  assert.deepEqual(sseEvents(b.text).at(-1), { error: 'L’analyse de la transcription a échoué.', code: 'ANALYSIS_FAILED' });
  behaviour = async () => { throw hostileError(); };
  const c = await req(app, '/api/capture/whisper', { body: { url: 'https://example.invalid/v' } });
  assertClean(c.text, 'whisper throw');
  assert.deepEqual(sseEvents(c.text).at(-1), { error: 'La transcription a échoué.', code: 'WHISPER_FAILED' });
  const v = await req(app, '/api/capture/whisper', { body: { url: 'ftp://x' } });
  assert.deepEqual([v.status, v.json.error], [400, 'URL invalide']);
});

test('Cyber Audit create/start/cancel: unknown exception is generic and clean; typed policy denial is preserved', async () => {
  let failure = hostileError();
  const gateway = {
    createMission: () => { throw failure; },
    getMission: () => null,
    listMissions: () => [],
    startMission: () => { throw failure; },
    cancelMission: () => { throw failure; },
    getMissionFindings: () => null,
    getMissionEvidence: () => null,
    getMissionEvents: () => null,
    getMissionReport: () => null,
  };
  const logs = [];
  const boundaryLogger = { warn: (fields, message) => logs.push(JSON.stringify({ fields, message })) };
  const app = new Hono();
  app.route('/api', createCyberAuditRoute({ gateway, logger: boundaryLogger, isLocal: () => true }));

  const unknown = [
    await req(app, '/api/cyber-audit/missions', { body: {} }),
    await req(app, '/api/cyber-audit/missions/id/start'),
    await req(app, '/api/cyber-audit/missions/id/cancel'),
  ];
  for (const response of unknown) {
    assert.deepEqual([response.status, response.json], [500, { error: 'cyber_audit_internal_error' }]);
    assertClean(response.text, 'cyber-audit unknown error');
  }
  assertClean(logs.join('\n'), 'cyber-audit logs', STORE_MARKERS);

  failure = new CyberAuditPolicyError('mission_not_found');
  const typed = await req(app, '/api/cyber-audit/missions/id/start');
  assert.deepEqual([typed.status, typed.json], [404, { error: 'mission_not_found' }]);
});

// ── 3. Legacy router (lib/router.js) and provider key test (routes/router.js) ─

test('legacy router: hostile local + cloud failures → nothing raw logged, the thrown aggregate carries a fixed message + per-attempt codes', async () => {
  const fake = await startHostileOllama({ models: ['llama3.2:3b', 'qwen2.5:7b'] });
  const client = createOllamaClient(fake.url);
  setCloudKey('groq', CONFIGURED_GROQ_KEY);
  try {
    const settings = { strict_local_mode: false, router_enabled: true, cloud_enabled: true, cloud_preference: 'quality' };
    setRouterSettings(settings);
    const hitsBefore = upstreamHits;
    let thrown = null;
    try { await routedCompletion(client, { action: 'rag_complex', input: 'analyse approfondie', context: { total_chars: 50_000 }, messages: [{ role: 'user', content: 'x' }], installedNames: ['llama3.2:3b', 'qwen2.5:7b'], settings, logger }); } catch (e) { thrown = e; }
    assert.ok(upstreamHits > hitsBefore, 'the hostile cloud upstream was really called');
    assert.ok(thrown && isPublicError(thrown), 'aggregate failure is a PublicError (Docteur-written)');
    assert.equal(thrown.code, 'ALL_MODELS_FAILED');
    assertClean(`${thrown.message} ${thrown.hint ?? ''} ${JSON.stringify(thrown.attempts ?? [])}`, 'routedCompletion aggregate');
    for (const a of thrown.attempts) assert.deepEqual(Object.keys(a).sort(), ['errorCode', 'level', 'model']);
    // strict-local and router-disabled paths: the final local failure is not relayed raw either.
    for (const s of [{ strict_local_mode: true }, { router_enabled: false }]) {
      let e2 = null;
      try { await routedCompletion(client, { action: 'rag_simple', input: 'x', messages: [{ role: 'user', content: 'x' }], installedNames: ['llama3.2:3b'], settings: s, logger }); } catch (e) { e2 = e; }
      assert.ok(e2 && isPublicError(e2), JSON.stringify(s)); assertClean(e2.message, 'routedCompletion local-only');
    }
    assert.equal(await tryCloudFallbackChain([{ role: 'user', content: 'x' }], { logger, settingsOverride: settings }), null);
    let e3 = null;
    try { await runAiTask({ feature: 'sec4b', taskType: 'summary', messages: [{ role: 'user', content: 'x' }], client, installedNames: ['llama3.2:3b'], settings, logger }); } catch (e) { e3 = e; }
    assert.ok(e3); assertClean(publicErrorMessage(e3, 'fallback'), 'runAiTask public message');
  } finally { setCloudKey('groq', ''); }
  const log = await readLog();
  assert.ok(log.includes('"errorCode"'), 'failures still logged with safe fields');
  assertClean(log, 'legacy router log', STORE_MARKERS);
});

test('POST /api/router/test/groq: hostile upstream echoing the key → fixed text from the closed category table, key never returned', async () => {
  const app = new Hono(); app.route('/api', createRouterRoute({ services: {}, logger }));
  const hitsBefore = upstreamHits;
  const r = await req(app, '/api/router/test/groq', { body: { key: CONFIGURED_GROQ_KEY } });
  assert.ok(upstreamHits > hitsBefore, 'the hostile upstream was really called');
  assert.ok(!r.text.includes(CONFIGURED_GROQ_KEY));
  assertClean(r.text, 'router test provider');
  assert.equal(r.json.ok, false); assert.equal(r.json.category, 'AUTH_FAILED'); assert.equal(typeof r.json.error, 'string');
  assertNoErrorInternals(r.json, 'router test provider');
});

// ── 4. Real boot of src/server.js (isolated DB / LanceDB / log, hostile loopback runtime + upstream) ─────────────

const BOOT_TIMEOUT = 120_000;
test('real boot: /api/answer (routed + private), /api/compare (local + cloud), app.onError, 404, validation — 0 raw in HTTP, log, activity_log, router_logs', { timeout: 300_000 }, async () => {
  const bootTmp = fs.mkdtempSync(path.join(tmp, 'boot-'));
  const SQLITE = path.join(bootTmp, 'cortex.sqlite'); const LANCE = path.join(bootTmp, 'cortex.lance'); const LOG = path.join(bootTmp, 'cortex.log'); const SPY = path.join(bootTmp, 'spy.txt');
  const fake = await startHostileOllama({ models: ['llama3.2:3b', 'qwen2.5:7b', 'qwen2.5:14b', 'nomic-embed-text'] });
  const PORT = 39_400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['--require', path.join(HERE, 'nb7-net-spy.cjs'), '--require', path.join(HERE, 'fixtures', 'sec4b-net-redirect.cjs'), path.join(HERE, 'src', 'server.js')], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), SQLITE_PATH: SQLITE, LANCEDB_PATH: LANCE, LOG_FILE: LOG, OLLAMA_URL: fake.url, ANSWER_MODEL: 'llama3.2:3b', EMBEDDING_MODEL: 'nomic-embed-text', NB7_SPY_FILE: SPY, SEC4B_UPSTREAM: UPSTREAM_URL, DOCTEUR_NO_BROWSER: '1', DOCTEUR_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stdout += d; });
  const kill = () => new Promise(res => { if (child.exitCode !== null) return res(); child.once('exit', () => res()); try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } setTimeout(res, 5000); });
  const call = (method, p, body, { raw = false } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (raw ? body : JSON.stringify(body));
    const headers = { host: `127.0.0.1:${PORT}`, connection: 'close', ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const rq = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent: false }, (rs) => { let t = ''; rs.on('data', d => { t += d; }); rs.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = null; } resolve({ status: rs.statusCode, text: t, json: j }); }); });
    rq.on('error', reject); rq.setTimeout(120_000, () => rq.destroy(new Error('timeout'))); if (data !== undefined) rq.write(data); rq.end();
  });
  try {
    const t0 = Date.now(); let up = false;
    while (Date.now() - t0 < BOOT_TIMEOUT && child.exitCode === null) { try { const h = await call('GET', '/api/health'); if (h.status === 200) { up = true; break; } } catch { /* not yet */ } await new Promise(r => setTimeout(r, 500)); }
    assert.ok(up, `isolated server booted (output tail: ${leaks(stdout, STORE_MARKERS).length ? '[hostile material in boot output]' : stdout.slice(-400)})`);

    // validation + unknown route keep their contract
    const v = await call('POST', '/api/answer', {});
    assert.deepEqual([v.status, v.json?.error], [400, 'Payload invalide. Champ requis: question.']);
    const nf = await call('GET', '/api/does-not-exist');
    assert.deepEqual([nf.status, nf.json?.error], [404, 'Route introuvable']);

    // routed answer (normal routing → every local level fails → fallback 7b fails)
    const idx = await call('POST', '/api/index', { id: 'sec4b-note', kind: 'note', title: 'Note SEC-4B', content: 'contenu de test' });
    assert.equal(idx.status, 200, `seed neuron: ${idx.text.slice(0, 200)}`);
    const chatsBefore = fake.state.chats;
    const a = await call('POST', '/api/answer', { question: 'Que dit la note ?' });
    assert.ok(fake.state.chats > chatsBefore, 'the hostile runtime was really called');
    assertClean(a.text, 'answer (routed)'); assertNoErrorInternals(a.json, 'answer (routed)');
    assert.ok(a.status >= 500 && typeof a.json?.error === 'string' && /^[A-Z_]+$/.test(a.json?.code), `answer routed: ${a.status} ${a.text.slice(0, 200)}`);

    // private source → forced local path ("Réponse locale impossible")
    await call('POST', '/api/index', { id: 'sec4b-cv', kind: 'cv', title: 'CV SEC-4B', content: 'contenu privé de test' });
    const pa = await call('POST', '/api/answer', { question: 'Que dit le CV ?' });
    assertClean(pa.text, 'answer (private)'); assertNoErrorInternals(pa.json, 'answer (private)');
    assert.equal(pa.status, 503); assert.match(pa.json.error, /^Réponse locale impossible/); assert.equal(pa.json.code, 'PROVIDER_ERROR'); assert.equal(typeof pa.json.hint, 'string');

    // app.onError: a malformed JSON body whose parser error echoes the input (route without its own catch)
    // (V8's JSON parser message quotes ~10 chars of the body: "DOCTEUR_SE" / "is not valid JSON" prove a raw relay.)
    const mj = await call('POST', '/api/voice/settings', `{"enabled": ${SECRETS.canary} ${FRAGMENTS.bearer}}`, { raw: true });
    assertClean(mj.text, 'onError malformed JSON', [...MARKERS, 'DOCTEUR_SE', 'is not valid JSON', 'Unexpected token']);
    assert.deepEqual([mj.status, mj.json], [500, { error: SAFE_INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR' }]);

    // compare: local model (hostile runtime) + groq (hostile upstream echoing the configured credential)
    const k = await call('POST', '/api/router/cloud-keys', { provider: 'groq', key: CONFIGURED_GROQ_KEY });
    assert.equal(k.status, 200, k.text.slice(0, 200));
    const hits = upstreamHits;
    const cmp = await call('POST', '/api/compare', { question: 'Que dit la note ?', models: ['llama3.2:3b', 'groq'] });
    assertClean(cmp.text, 'compare'); assert.ok(!cmp.text.includes(CONFIGURED_GROQ_KEY));
    const events = sseEvents(cmp.text);
    const errs = events.filter(e => e.type === 'error');
    assert.ok(errs.length >= 1, `compare emitted error events: ${cmp.text.slice(0, 300)}`);
    for (const e of errs) { assert.equal(typeof e.error, 'string'); assert.match(String(e.code), /^[A-Z_]+$/); assertNoErrorInternals(e, 'compare event'); }
    const cloudReached = upstreamHits > hits;
    const groqEvent = errs.find(e => e.model_id === 'groq');
    assert.ok(groqEvent, 'groq failure reported');
    if (cloudReached) assert.equal(groqEvent.code, 'PROVIDER_ERROR');
    test.diagnostic?.(`compare cloud upstream reached: ${cloudReached}`);
    globalThis.__sec4bCloudReached = cloudReached;
  } finally {
    await kill();
  }
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  assert.ok(log.length > 0, 'isolated log written');
  assertClean(log, 'server log file', STORE_MARKERS);
  assertClean(stdout, 'server stdout/stderr', STORE_MARKERS);
  const db = new Database(SQLITE, { readonly: true, fileMustExist: true });
  try {
    const activity = db.prepare('SELECT * FROM activity_log').all();
    const routerLogs = db.prepare('SELECT * FROM router_logs').all();
    assert.ok(activity.some(r => r.op_type === 'question' && r.result === 'failure'), 'answer failures recorded');
    assertClean(JSON.stringify(activity), 'activity_log', STORE_MARKERS);
    assertClean(JSON.stringify(routerLogs), 'router_logs', STORE_MARKERS);
    for (const r of activity.filter(x => x.result === 'failure' && x.reason)) assert.match(String(r.reason), /^[A-Za-z_]+$/, `activity reason ${r.op_type}`);
    for (const r of routerLogs.filter(x => x.error_message)) assert.match(String(r.error_message), /^[A-Z_]+$/, 'router_logs error_message is a code');
  } finally { db.close(); }
  const spy = fs.existsSync(SPY) ? fs.readFileSync(SPY, 'utf8').trim() : '';
  assert.equal(spy, '', `no non-loopback network attempt: ${spy.slice(0, 300)}`);
});

// ── 5. Static: the boundary files no longer copy error text ───────────────────

const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8').replace(/\r\n/g, '\n');
const code = (text) => text.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
test('static: PublicError is never built from another error’s text; boundary routes never return / log err.message', () => {
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) all.push(p); } };
  walk(path.join(HERE, 'src'));
  for (const f of all) {
    for (const line of code(fs.readFileSync(f, 'utf8')).split('\n').filter(l => /new PublicError\(/.test(l))) {
      assert.doesNotMatch(line, /\b(err|error|e|err2|cause)\??\.(message|stack|cause)|String\((err|error|e)\)|\$\{(err|error|e)\b/, `${path.relative(HERE, f)}: ${line.trim()}`);
    }
  }
  // Reading the text to CLASSIFY (a comparison, a lower-cased copy fed to a matcher) is allowed; relaying it is not.
  const relays = (text) => code(text).split('\n').filter(l => !/\.message\s*===|const msg = String\(err\?\.message/.test(l)).join('\n');
  for (const f of ['src/routes/answer.js', 'src/routes/compare.js', 'src/routes/vision.js', 'src/routes/voice.js']) {
    assert.doesNotMatch(relays(src(f)),/\b(err|error|e)\??\.(message|stack|cause)\b|\{ err: (e|err|error) \}/, f);
  }
  const capture = code(src('src/routes/capture.js'));
  const whisper = capture.slice(capture.indexOf("route.post('/capture/whisper'"), capture.indexOf("route.get('/capture/whisper/stats'"));
  assert.ok(whisper.length > 100);
  // err.message only behind isPublicError(err) (Docteur-written); the service's result.error is never relayed.
  assert.doesNotMatch(whisper.split('\n').filter(l => !/isPublicError\(err\) \? \{ error: err\.message/.test(l)).join('\n'), /\b(err|error)\??\.message\b|result\.error/);
  const server = code(src('src/server.js'));
  const onError = server.slice(server.indexOf('app.onError('), server.indexOf('app.notFound('));
  assert.match(onError, /createSafeErrorHandler/); assert.doesNotMatch(onError, /\.message/);
  for (const fn of ['async function answerQuestion(', 'async function compareModels(']) {
    const body = server.slice(server.indexOf(fn), server.indexOf('\n}\n', server.indexOf(fn)));
    assert.ok(body.length > 200, fn);
    const relayed = body.split('\n').filter(l => !/if \(isPublicError\(err\)\) return/.test(l)).join('\n'); // PublicError = Docteur text
    assert.doesNotMatch(relayed, /\b(err|err2|error)\??\.message\b/, fn);
  }
  const answers = server.slice(server.indexOf('answerQuestion: async (payload)'), server.indexOf('captureInput: async (payload)'));
  assert.doesNotMatch(answers, /reason: err\.message/);
  const legacy = code(src('src/lib/router.js'));
  for (const l of legacy.split('\n').filter(x => /logger\?*\.(warn|error|info)/.test(x))) assert.doesNotMatch(l, /\b(err|error)\??\.message\b/, l.trim());
  assert.doesNotMatch(legacy, /Détails: \$\{/);
});

test('real user DB untouched by this suite', () => {
  assert.equal(sha256File(REAL_DB), REAL_DB_HASH_BEFORE);
});
