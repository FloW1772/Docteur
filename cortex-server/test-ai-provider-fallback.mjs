// Tests for the centralized AI provider fallback/cooldown/redaction system.
// Run with: node --test test-ai-provider-fallback.mjs

import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { initSqlite, setCloudKey, getCloudKeys, getCloudKeysMasked, getCloudKeyStatuses, setRouterSettings, setMeta, getMeta } from './src/lib/sqlite.js';
import { getSecretStatus } from './src/lib/secret-store.js';
import { tryCloudFallbackChain, runAiTask, getCloudProviderStatuses, clearProviderCooldown } from './src/lib/router.js';
import { recordFailure, recordSuccess, isInCooldown, getProviderStatus, ProviderState, _resetAllForTests } from './src/lib/provider-state.js';
import { ErrorCategory, classifiedError, classifyHttpError, classifyNetworkError } from './src/lib/provider-errors.js';
import { redactSecrets, createLogger } from './src/lib/logger.js';
import * as gemini from './src/lib/providers/gemini.js';
import { savePageToStoreIfNewer } from './src/lib/sqlite.js';
import { scanPagesForSecretsFromPages, scanPagesForSecrets } from './src/lib/secret-scan.js';
import { claudeOAuthProvider } from './src/lib/providers/claude-oauth.js';
import { codexProvider } from './src/lib/providers/codex.js';

const TEST_DB = './data-test-fallback/test.db';

before(() => {
  fs.rmSync('./data-test-fallback', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  // Best-effort cleanup — better-sqlite3 may still hold the file handle open
  // on Windows momentarily after the process ends; not worth failing the run over.
  try { fs.rmSync('./data-test-fallback', { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  // Reset cloud keys and all provider health state between tests
  for (const p of ['gemini', 'groq', 'openrouter', 'anthropic', 'openai']) {
    setCloudKey(p, '');
  }
  _resetAllForTests();
  setRouterSettings({ paying_apis_enabled: false, strict_local_mode: false, claude_mode: 'subscription', openai_mode: 'subscription' });
});

// ── Secret storage & redaction ────────────────────────────────────────────────

test('secret storage: keys round-trip through DPAPI and are never plaintext at rest', () => {
  setCloudKey('openai', 'sk-proj-supersecretvalue123456');
  assert.equal(getCloudKeys().openai_key, 'sk-proj-supersecretvalue123456');

  const masked = getCloudKeysMasked();
  assert.ok(masked.openai_key.includes('•'));
  assert.ok(!masked.openai_key.includes('supersecretvalue'));
  assert.equal(masked.openai_active, true);
});

test('secret storage: decrypts correctly on a COLD read (in-memory cache cleared) — regression for missing Add-Type in unprotect()', async () => {
  // A same-process set()+get() round-trip alone is not a real test of DPAPI
  // decryption: it can pass purely off the in-memory cache while the actual
  // PowerShell Unprotect() call is silently broken (this happened in
  // production: unprotect() was missing `Add-Type -AssemblyName
  // System.Security`, so the type could not be found, the call failed, the
  // catch swallowed it, and every key read back as null after any process
  // restart). Force a cold read by re-importing secret-store.js fresh.
  const { setSecret } = await import('./src/lib/secret-store.js?cachebust=' + Date.now());
  setSecret('groq', 'gsk_coldreadtestvalue1234567890');

  // Re-import again to get a fresh module instance with an empty cache,
  // simulating a server restart where the cache starts cold but the
  // ciphertext is already in SQLite.
  const fresh = await import('./src/lib/secret-store.js?cachebust=' + (Date.now() + 1));
  const recovered = fresh.getSecret('groq');
  assert.equal(recovered, 'gsk_coldreadtestvalue1234567890');
});

test('secret storage: deleting a key returns it to null', () => {
  setCloudKey('anthropic', 'sk-ant-abc123456789');
  assert.equal(getCloudKeys().anthropic_key, 'sk-ant-abc123456789');
  setCloudKey('anthropic', '');
  assert.equal(getCloudKeys().anthropic_key, null);
});

// ── credential_invalid state: distinguishing "corrupted blob" from ────────────
// "never configured" (getSecretStatus / getCloudKeyStatuses / /router/providers
// /router/test/:provider). Uses a distinct synthetic provider id per case so
// this suite's shared beforeEach reset (which blanks the 5 real provider ids)
// never interferes with these.

test('credential status: absent when no blob was ever stored', () => {
  setCloudKey('groq', ''); // ensure blank via the real provider id path too
  assert.equal(getSecretStatus('never_configured_test_provider'), 'absent');
  assert.equal(getCloudKeys().groq_key, null);
});

test('credential status: valid when a real blob decrypts successfully', () => {
  setCloudKey('groq', 'gsk_validcredentialtestvalue999888');
  assert.equal(getSecretStatus('groq'), 'valid');
  assert.equal(getCloudKeyStatuses().groq, 'valid');
});

test('credential status: invalid (credential_invalid) when the blob exists but cannot be decrypted — never exposes the blob, never crashes, never auto-deletes', () => {
  // Inject a deliberately corrupted DPAPI blob directly — never a real key.
  setMeta('secret_dpapi:groq', { ciphertext: 'CORRUPTED_NOT_VALID_DPAPI_BASE64_GARBAGE_0000000000' });

  let threw = false;
  let status;
  try {
    status = getSecretStatus('groq');
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'getSecretStatus must never throw on a corrupted blob');
  assert.equal(status, 'invalid');
  assert.equal(getCloudKeyStatuses().groq, 'invalid');
  // getCloudKeys() must keep returning null (never the corrupted blob, never a crash)
  assert.equal(getCloudKeys().groq_key, null);
  // The blob itself must still be present in storage — corrupted secrets are
  // never auto-deleted, only replaced or explicitly deleted by the user.
  // Only checks presence (truthy), never reads/logs the ciphertext content.
  assert.ok(getMeta('secret_dpapi:groq', null) !== null);
});

test('credential status: replacing an invalid blob with a new valid key clears the invalid state and returns to valid/ready', async () => {
  setMeta('secret_dpapi:groq', { ciphertext: 'ANOTHER_CORRUPTED_GARBAGE_BLOB_1111111111' });
  assert.equal(getSecretStatus('groq'), 'invalid');

  setCloudKey('groq', 'gsk_freshvalidkeyafterreplace777666');

  assert.equal(getSecretStatus('groq'), 'valid');
  assert.equal(getCloudKeys().groq_key, 'gsk_freshvalidkeyafterreplace777666');
  assert.equal(getCloudKeyStatuses().groq, 'valid');
});

test('/router/providers and /router/test reflect credential_invalid distinctly from auth_required', async () => {
  const { createRouterRoute } = await import('./src/routes/router.js');
  setMeta('secret_dpapi:groq', { ciphertext: 'ROUTE_LEVEL_CORRUPTED_BLOB_2222222222' });

  const services = { ollamaHealth: async () => ({ connected: false, models: [] }) };
  const route = createRouterRoute({ services });

  const providersRes = await route.request('/router/providers');
  const providersBody = await providersRes.json();
  const groqEntry = providersBody.providers.find(p => p.id === 'groq');
  assert.equal(groqEntry.status, 'credential_invalid');
  assert.equal(groqEntry.credential_invalid, true);
  assert.equal(groqEntry.configured, false);
  assert.equal(groqEntry.enabled, false);

  const testRes = await route.request('/router/test/groq', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const testBody = await testRes.json();
  assert.equal(testBody.ok, false);
  assert.equal(testBody.state, 'credential_invalid');
  assert.match(testBody.error, /ressaisir/i);

  // Replacing with a fresh valid key clears the invalid state end-to-end
  await route.request('/router/cloud-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'groq', key: 'gsk_endtoendreplacementkey333444' }) });
  const afterRes = await route.request('/router/providers');
  const afterBody = await afterRes.json();
  const groqAfter = afterBody.providers.find(p => p.id === 'groq');
  assert.equal(groqAfter.credential_invalid, false);
  assert.equal(groqAfter.configured, true);
});

test('redactSecrets: strips API keys and bearer tokens from free-text', () => {
  const text = 'Authorization: Bearer sk-ant-abcdef123456789 and key=sk-proj-xyz987654321';
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes('sk-ant-abcdef123456789'));
  assert.ok(!redacted.includes('sk-proj-xyz987654321'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('logger: redacts known secret fields via Pino path-based redaction', () => {
  const chunks = [];
  const logger = createLogger({ level: 'info' });
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  try {
    logger.info({ apiKey: 'sk-verysecretvalue1234567890' }, 'test');
  } finally {
    process.stdout.write = origWrite;
  }
  const output = chunks.join('');
  assert.ok(!output.includes('sk-verysecretvalue1234567890'));
  assert.ok(output.includes('[REDACTED]'));
});

// ── Error classification ──────────────────────────────────────────────────────

test('classifyHttpError: 401/403 -> AUTH_FAILED', () => {
  assert.equal(classifyHttpError(401, {}), ErrorCategory.AUTH_FAILED);
  assert.equal(classifyHttpError(403, {}), ErrorCategory.AUTH_FAILED);
});

test('classifyHttpError: 404 -> MODEL_UNAVAILABLE', () => {
  assert.equal(classifyHttpError(404, {}), ErrorCategory.MODEL_UNAVAILABLE);
});

test('classifyHttpError: 429 with quota wording -> QUOTA_EXCEEDED, otherwise RATE_LIMITED', () => {
  assert.equal(classifyHttpError(429, { error: { message: 'You exceeded your current quota' } }), ErrorCategory.QUOTA_EXCEEDED);
  assert.equal(classifyHttpError(429, { error: { message: 'insufficient_quota' } }), ErrorCategory.QUOTA_EXCEEDED);
  assert.equal(classifyHttpError(429, { error: { message: 'rate limit reached, slow down' } }), ErrorCategory.RATE_LIMITED);
});

test('classifyHttpError: context length errors -> CONTEXT_TOO_LONG', () => {
  assert.equal(classifyHttpError(400, { error: { message: 'context_length_exceeded: too many tokens' } }), ErrorCategory.CONTEXT_TOO_LONG);
  assert.equal(classifyHttpError(413, {}), ErrorCategory.CONTEXT_TOO_LONG);
});

test('classifyHttpError: 5xx -> PROVIDER_UNAVAILABLE', () => {
  assert.equal(classifyHttpError(500, {}), ErrorCategory.PROVIDER_UNAVAILABLE);
  assert.equal(classifyHttpError(503, {}), ErrorCategory.PROVIDER_UNAVAILABLE);
});

test('classifyNetworkError: AbortError/TimeoutError -> TIMEOUT, else NETWORK_ERROR', () => {
  assert.equal(classifyNetworkError({ name: 'TimeoutError' }), ErrorCategory.TIMEOUT);
  assert.equal(classifyNetworkError({ name: 'AbortError' }), ErrorCategory.TIMEOUT);
  assert.equal(classifyNetworkError({ name: 'FetchError' }), ErrorCategory.NETWORK_ERROR);
});

// ── Gemini 400 auth-vs-other classification ───────────────────────────────────
// Regression for: Gemini returns HTTP 400 (not 401) for an invalid/malformed
// API key, which was previously falling through to UNKNOWN/error instead of
// AUTH_FAILED/auth_required. Body shapes below are the exact real responses
// captured live from generativelanguage.googleapis.com.

function withMockedFetch(responseFactory, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseFactory();
  return fn().finally(() => { globalThis.fetch = originalFetch; });
}

test('gemini: a 400 with reason API_KEY_INVALID classifies as AUTH_FAILED', async () => {
  const realInvalidKeyBody = {
    error: {
      code: 400,
      message: 'API key not valid. Please pass a valid API key.',
      status: 'INVALID_ARGUMENT',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
        { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' },
      ],
    },
  };

  await withMockedFetch(
    () => new Response(JSON.stringify(realInvalidKeyBody), { status: 400 }),
    async () => {
      await assert.rejects(
        gemini.complete({ apiKey: 'bad', model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
        (err) => {
          assert.equal(err.isAuth, true);
          assert.equal(err.category, ErrorCategory.AUTH_FAILED);
          return true;
        },
      );
    },
  );
});

test('gemini: an unrelated 400 (e.g. malformed request body) stays out of AUTH_FAILED', async () => {
  const unrelatedBadRequestBody = {
    error: {
      code: 400,
      message: 'Invalid JSON payload received. Unknown name "foo": Cannot find field.',
      status: 'INVALID_ARGUMENT',
    },
  };

  await withMockedFetch(
    () => new Response(JSON.stringify(unrelatedBadRequestBody), { status: 400 }),
    async () => {
      await assert.rejects(
        gemini.complete({ apiKey: 'whatever', model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
        (err) => {
          assert.equal(err.isAuth, false);
          assert.notEqual(err.category, ErrorCategory.AUTH_FAILED);
          return true;
        },
      );
    },
  );
});

test('gemini: a 400 with the literal "API key not valid" message but no structured reason still classifies as AUTH_FAILED (fallback path)', async () => {
  const messageOnlyBody = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } };

  await withMockedFetch(
    () => new Response(JSON.stringify(messageOnlyBody), { status: 400 }),
    async () => {
      await assert.rejects(
        gemini.complete({ apiKey: 'bad', model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
        (err) => {
          assert.equal(err.isAuth, true);
          assert.equal(err.category, ErrorCategory.AUTH_FAILED);
          return true;
        },
      );
    },
  );
});

test('gemini: real 401/403 still classify as AUTH_FAILED (unaffected by the 400 change)', async () => {
  await withMockedFetch(
    () => new Response(JSON.stringify({ error: { code: 403, message: 'Permission denied' } }), { status: 403 }),
    async () => {
      await assert.rejects(
        gemini.complete({ apiKey: 'bad', model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] }),
        (err) => {
          assert.equal(err.isAuth, true);
          assert.equal(err.category, ErrorCategory.AUTH_FAILED);
          return true;
        },
      );
    },
  );
});

// ── Provider state / cooldown ──────────────────────────────────────────────────

test('provider-state: AUTH_FAILED puts provider into cooldown', () => {
  assert.equal(isInCooldown('openai'), false);
  recordFailure('openai', classifiedError('bad key', ErrorCategory.AUTH_FAILED));
  assert.equal(isInCooldown('openai'), true);
  const status = getProviderStatus('openai');
  assert.equal(status.state, ProviderState.AUTH_REQUIRED);
  assert.equal(status.in_cooldown, true);
});

test('provider-state: QUOTA_EXCEEDED puts provider into a long cooldown', () => {
  recordFailure('anthropic', classifiedError('quota gone', ErrorCategory.QUOTA_EXCEEDED));
  const status = getProviderStatus('anthropic');
  assert.equal(status.state, ProviderState.QUOTA_EXHAUSTED);
  assert.equal(status.in_cooldown, true);
  assert.ok(status.cooldown_remaining_ms > 5 * 60 * 1000); // > 5 min, matches 30 min policy
});

test('provider-state: RATE_LIMITED respects a provider-supplied Retry-After over the default', () => {
  recordFailure('groq', classifiedError('slow down', ErrorCategory.RATE_LIMITED, { retryAfterMs: 5000 }));
  const status = getProviderStatus('groq');
  assert.equal(status.state, ProviderState.RATE_LIMITED);
  assert.ok(status.cooldown_remaining_ms <= 5000);
});

test('provider-state: CONTEXT_TOO_LONG does not trigger any cooldown (not a health issue)', () => {
  recordFailure('gemini', classifiedError('too long', ErrorCategory.CONTEXT_TOO_LONG));
  assert.equal(isInCooldown('gemini'), false);
});

test('provider-state: recordSuccess clears any prior cooldown/error state', () => {
  recordFailure('groq', classifiedError('offline', ErrorCategory.PROVIDER_UNAVAILABLE));
  assert.equal(isInCooldown('groq'), true);
  recordSuccess('groq');
  assert.equal(isInCooldown('groq'), false);
  assert.equal(getProviderStatus('groq').state, ProviderState.READY);
});

test('provider-state: clearProviderCooldown (manual "Retester maintenant") bypasses cooldown immediately', () => {
  recordFailure('openai', classifiedError('rate limited', ErrorCategory.RATE_LIMITED, { retryAfterMs: 60_000 }));
  assert.equal(isInCooldown('openai'), true);
  clearProviderCooldown('openai');
  assert.equal(isInCooldown('openai'), false);
});

// ── Centralized fallback chain ────────────────────────────────────────────────

test('tryCloudFallbackChain: returns null when no cloud provider is configured', async () => {
  const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
  assert.equal(result, null);
});

test('tryCloudFallbackChain: returns null under strict_local_mode even with keys configured', async () => {
  setCloudKey('groq', 'fake-key');
  setRouterSettings({ strict_local_mode: true });
  const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
  assert.equal(result, null);
});

test('tryCloudFallbackChain: paid providers (anthropic/openai) are excluded unless paying_apis_enabled is true', async () => {
  setCloudKey('anthropic', 'fake-key');
  setRouterSettings({ paying_apis_enabled: false });
  // No free providers configured and paid disabled -> no candidates at all -> null
  const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
  assert.equal(result, null);
});

test('tryCloudFallbackChain: a provider in cooldown is skipped, leaving no candidates if it was the only one', async () => {
  setCloudKey('groq', 'fake-key');
  recordFailure('groq', classifiedError('auth failed', ErrorCategory.AUTH_FAILED));
  const status = getCloudProviderStatuses();
  assert.equal(status.groq.in_cooldown, true);

  const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
  assert.equal(result, null); // groq is the only configured provider and it's cooling down
});

test('runAiTask: strict local blocks cloud even when a cloud provider is preferred', async () => {
  setCloudKey('groq', 'gsk_test_provider_key');
  setRouterSettings({ strict_local_mode: true, cloud_enabled: true });
  const calls = [];
  const result = await runAiTask({
    feature: 'prompt_generator',
    taskType: 'prompt_draft',
    preferredProvider: 'groq',
    preferredModel: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'test' }],
    client: { chat: async options => { calls.push(options); return { message: { content: 'local result' } }; } },
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.provider, 'local');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'llama3.2:3b');
});

test('runAiTask: unavailable explicit provider falls back to local without paid escalation', async () => {
  setCloudKey('groq', 'gsk_test_provider_key');
  setRouterSettings({ strict_local_mode: false, cloud_enabled: true, paying_apis_enabled: false });
  recordFailure('groq', new Error('provider unavailable'));
  const result = await runAiTask({
    feature: 'prompt_generator',
    taskType: 'prompt_review',
    preferredProvider: 'groq',
    preferredModel: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'test' }],
    client: { chat: async () => ({ message: { content: 'fallback result' } }) },
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.provider, 'local');
  assert.equal(result.fallback, true);
});

test('getCloudProviderStatuses: reports ready for a configured provider with no recorded failure', () => {
  setCloudKey('gemini', 'fake-key');
  const statuses = getCloudProviderStatuses();
  assert.equal(statuses.gemini.state, ProviderState.READY);
  assert.equal(statuses.gemini.in_cooldown, false);
});

// ── secret-scan: audit of "sk-"-like patterns in user content ─────────────────
// All test content below is synthetic (SYNTH marker), never a real key shape
// that could be confused with production data.

test('secret-scan: never includes the matched text anywhere in its output, even for a plausible real secret', () => {
  const page = { id: 'scan-test-1', title: 'note', metadata: {}, blocks: [
    { id: 'b1', content: `some prose sk-SYNTHREALLOOKING9f8e7d6c5b4a3210 more prose` },
  ] };
  const result = scanPagesForSecretsFromPages([page]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('SYNTHREALLOOKING9f8e7d6c5b4a3210'));
  assert.ok(result.total_matches >= 1);
});

test('secret-scan: classifies example/documentation-flavored text as likely_example_text, not plausible', () => {
  const page = { id: 'scan-test-2', title: 'doc', metadata: {}, blocks: [
    { id: 'b1', content: 'Example: set your key like sk-your-api-key-here-xxxxxxxxxx in the .env file (placeholder)' },
  ] };
  const result = scanPagesForSecretsFromPages([page]);
  assert.ok(result.total_matches >= 1);
  assert.equal(result.plausible_real_secret, 0);
});

test('secret-scan: a high-entropy unbroken run with no example hints scores as plausible_real_secret', () => {
  const page = { id: 'scan-test-3', title: 'note', metadata: {}, blocks: [
    { id: 'b1', content: 'gsk_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' },
  ] };
  const result = scanPagesForSecretsFromPages([page]);
  assert.equal(result.plausible_real_secret, 1);
  assert.equal(result.pages_to_review.length, 1);
  assert.equal(result.pages_to_review[0].page_id, 'scan-test-3');
});

test('secret-scan: recognises all requested prefixes (gsk_, AIza, sk-ant-, sk-or-, sk-, Bearer, api_key=, token=)', () => {
  const samples = [
    'gsk_SYNTH1234567890ABCDEFGHIJ',
    'AIzaSYNTH1234567890ABCDEFGHIJKLMNOPQ',
    'sk-ant-SYNTH1234567890ABCDEFGHIJ',
    'sk-or-SYNTH1234567890ABCDEFGHIJ',
    'sk-SYNTH1234567890ABCDEFGHIJ',
    'Bearer SYNTH1234567890ABCDEFGHIJ',
    'api_key=SYNTH1234567890',
    'token=SYNTH1234567890',
  ];
  const page = { id: 'scan-test-4', title: 'note', metadata: {}, blocks: [{ id: 'b1', content: samples.join(' | ') }] };
  const result = scanPagesForSecretsFromPages([page]);
  assert.equal(result.total_matches, samples.length);
});

test('secret-scan: produces only non-sensitive metadata fields (id, field, length, position, fingerprint, score) — no raw text field exists on findings', () => {
  const page = { id: 'scan-test-5', title: 'note', metadata: {}, blocks: [{ id: 'b1', content: 'sk-SYNTHVALUEFORFIELDCHECK1234567890' }] };
  const result = scanPagesForSecretsFromPages([page]);
  const review = result.pages_to_review[0];
  const keys = Object.keys(review).toSorted();
  assert.deepEqual(keys, ['fields', 'highest_score', 'match_count', 'page_id']);
});

test('secret-scan: scanPagesForSecrets() runs against the live (test) store without throwing and without a network call', () => {
  savePageToStoreIfNewer({ id: 'scan-integration-test', title: 'integration', kind: 'note', blocks: [{ id: 'b1', type: 'paragraph', content: 'no secret here' }], links: [], createdAt: 1, updatedAt: 1, metadata: {} });

  let networkCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalled = true; throw new Error('unexpected'); };

  let threw = false;
  let result;
  try {
    result = scanPagesForSecrets();
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(threw, false);
  assert.equal(networkCalled, false);
  assert.ok(typeof result.total_matches === 'number');
});

// ── CLOUD_COMPARE_IDS / compareModels() consistency ────────────────────────────
// compareModels() is a private closure inside server.js (only reachable via
// the full booted server's `services` object), so this checks the actual
// invariant the bug violated — every id listed in CLOUD_COMPARE_IDS has a
// real `if (modelId === '<id>')` implementation branch in callOneModel() —
// directly against the source, rather than requiring a full server boot.
test('server.js: CLOUD_COMPARE_IDS only lists providers callOneModel() actually implements', () => {
  const source = fs.readFileSync('./src/server.js', 'utf8');

  const setMatch = source.match(/const CLOUD_COMPARE_IDS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(setMatch, 'CLOUD_COMPARE_IDS declaration not found in server.js');
  const listedIds = setMatch[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));

  const compareSection = source.slice(source.indexOf('async function compareModels'));
  const callOneModelSection = compareSection.slice(0, compareSection.indexOf('const localModels ='));

  for (const id of listedIds) {
    const hasBranch = callOneModelSection.includes(`modelId === '${id}'`);
    assert.ok(hasBranch, `CLOUD_COMPARE_IDS lists '${id}' but callOneModel() has no implementation branch for it`);
  }

  // Anthropic/OpenAI were removed specifically because they had no branch —
  // guard against them being silently re-added without an implementation.
  assert.ok(!listedIds.includes('anthropic') || callOneModelSection.includes("modelId === 'anthropic'"));
  assert.ok(!listedIds.includes('openai') || callOneModelSection.includes("modelId === 'openai'"));
});

// ── PAIR endpoint: configurable, persisted, reloaded on restart ──────────────
// Regression for: the pairProvider singleton used by routedCompletion() never
// read back the user-configured endpoint — it was silently pinned to
// localhost:8080 forever regardless of what Settings > PAIR saved.

test('PAIR endpoint: /router/pair-settings POST persists and immediately updates the live singleton', async () => {
  const { createRouterRoute } = await import('./src/routes/router.js');
  const { pairProvider } = await import('./src/lib/providers/pair.js');
  const services = { ollamaHealth: async () => ({ connected: false, models: [] }) };
  const route = createRouterRoute({ services });

  const res = await route.request('/router/pair-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'http://localhost:9191' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.endpoint, 'http://localhost:9191');
  assert.equal(pairProvider.endpoint, 'http://localhost:9191');

  // GET reflects the same persisted value
  const getRes = await route.request('/router/pair-settings');
  assert.equal((await getRes.json()).endpoint, 'http://localhost:9191');

  pairProvider.setEndpoint(null); // reset for other tests
});

test('PAIR endpoint: loadPairEndpointFromStorage() reloads the persisted setting — simulates a server restart', async () => {
  const { pairProvider, loadPairEndpointFromStorage } = await import('./src/lib/providers/pair.js');
  setMeta('pair_endpoint', 'http://localhost:9292');
  pairProvider.setEndpoint(null); // simulate a fresh process (constructor default)
  assert.equal(pairProvider.endpoint, 'http://localhost:8080');

  loadPairEndpointFromStorage(getMeta, null);
  assert.equal(pairProvider.endpoint, 'http://localhost:9292');

  pairProvider.setEndpoint(null); // reset for other tests
  setMeta('pair_endpoint', null);
});

test('PAIR endpoint: falls back to PAIR_ENDPOINT env var, then default, when nothing is persisted', async () => {
  setMeta('pair_endpoint', null);
  const original = process.env.PAIR_ENDPOINT;
  process.env.PAIR_ENDPOINT = 'http://localhost:9393';
  try {
    const { PAIRProvider } = await import('./src/lib/providers/pair.js?cachebust=' + Date.now());
    const fresh = new PAIRProvider();
    assert.equal(fresh.endpoint, 'http://localhost:9393');
  } finally {
    if (original === undefined) delete process.env.PAIR_ENDPOINT;
    else process.env.PAIR_ENDPOINT = original;
  }
});

// ── OAuth provider test route: claude-oauth / codex bypass the API-key path ──

test('/router/test/claude-oauth and /router/test/codex never require an API key — they invoke the CLI tester directly', async () => {
  const { createRouterRoute } = await import('./src/routes/router.js');
  const services = { ollamaHealth: async () => ({ connected: false, models: [] }) };
  const route = createRouterRoute({ services });

  for (const provider of ['claude-oauth', 'codex']) {
    const res = await route.request(`/router/test/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    // On a machine without the CLI installed/authenticated this must be a
    // clean auth_required/unavailable, never "Aucune clé configurée" (that
    // message is for API-key providers and would be misleading here).
    assert.notEqual(body.error, 'Aucune clé configurée');
    assert.ok('authMode' in body);
  }
});

// ── Secret scrub in /router/test/:provider error responses ──────────────────
// Regression for: a provider's own error text can echo the submitted key back
// (even partially masked, e.g. OpenAI's "Incorrect API key provided: sk-Xy...
// ...abcd"), which must never survive into the client-facing error message.

test('/router/test/:provider strips the submitted key from the error message, including partial/masked echoes', async () => {
  const { createRouterRoute } = await import('./src/routes/router.js');
  const services = { ollamaHealth: async () => ({ connected: false, models: [] }) };
  const route = createRouterRoute({ services });

  const originalFetch = globalThis.fetch;
  const secret = 'TEST_SECRET_DO_NOT_LOG_123';
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: `Incorrect API key provided: ${secret.slice(0, 8)}****${secret.slice(-4)}` } }),
    { status: 401 },
  );
  try {
    const res = await route.request('/router/test/openai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: secret }),
    });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(!body.error.includes(secret));
    assert.ok(!body.error.includes(secret.slice(0, 8)));
    assert.ok(!body.error.includes(secret.slice(-4)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Claude / OpenAI subscription vs API mode — mutual exclusivity ────────────
// Regression for: claude-oauth/codex used to require paying_apis_enabled=true
// to ever be added as a candidate, even though they're subscription-based
// (Claude Code CLI / Codex CLI) and cost Docteur nothing per call. A user who
// only wants subscription mode should never have to touch that toggle, and
// once a mode is selected, the other backend for that provider must never be
// silently tried.

test('claude subscription mode: claude-oauth is a router candidate WITHOUT paying_apis_enabled, as long as the CLI reports configured', async () => {
  setRouterSettings({ claude_mode: 'subscription', paying_apis_enabled: false });
  const originalConfigured = claudeOAuthProvider.isConfigured;
  const originalGenerate   = claudeOAuthProvider.generate;
  claudeOAuthProvider.isConfigured = async () => true;
  claudeOAuthProvider.generate     = async () => ({ text: 'OK', model: 'claude-oauth/mock' });
  try {
    const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
    // Mocked generate() succeeds, so a non-null result here proves
    // claude-oauth was actually SELECTED and CALLED as a candidate — not
    // skipped for lack of paying_apis_enabled (the old, wrong gate).
    assert.notEqual(result, null, 'claude-oauth must be attempted (not skipped) even with paying_apis_enabled=false');
    assert.equal(result.provider, 'claude-oauth');
  } finally {
    claudeOAuthProvider.isConfigured = originalConfigured;
    claudeOAuthProvider.generate     = originalGenerate;
    setRouterSettings({ claude_mode: 'subscription', paying_apis_enabled: false });
  }
});

test('claude API mode: anthropic key is IGNORED unless paying_apis_enabled=true (billed usage stays gated)', async () => {
  setRouterSettings({ claude_mode: 'api', paying_apis_enabled: false });
  setCloudKey('anthropic', 'sk-ant-faketest123456789');
  const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
  assert.equal(result, null, 'anthropic API mode must still require paying_apis_enabled even with a key configured');
});

test('claude mode exclusivity: selecting "api" mode never adds claude-oauth as a candidate, even if the CLI is configured', async () => {
  setRouterSettings({ claude_mode: 'api', paying_apis_enabled: true });
  setCloudKey('anthropic', ''); // no key — so if claude-oauth were still added despite api mode, it would be the only candidate
  const original = claudeOAuthProvider.isConfigured;
  claudeOAuthProvider.isConfigured = async () => true; // CLI reports configured
  try {
    const statuses = getCloudProviderStatuses();
    const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
    // No anthropic key + api mode selected + claude-oauth must NOT be used as
    // a fallback → no candidates at all → null.
    assert.equal(result, null, 'claude-oauth must never be used when claude_mode is "api", regardless of CLI state');
  } finally {
    claudeOAuthProvider.isConfigured = original;
  }
});

test('claude mode exclusivity: selecting "subscription" mode never adds the Anthropic API as a candidate, even with a valid key', async () => {
  setRouterSettings({ claude_mode: 'subscription', paying_apis_enabled: true });
  setCloudKey('anthropic', 'sk-ant-faketest123456789');
  const original = claudeOAuthProvider.isConfigured;
  claudeOAuthProvider.isConfigured = async () => false; // CLI not configured
  try {
    const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
    // Subscription mode selected, CLI not configured, anthropic key present
    // but must be ignored entirely — no silent fallback to the paid API.
    assert.equal(result, null, 'anthropic API must never be used as a fallback when claude_mode is "subscription"');
  } finally {
    claudeOAuthProvider.isConfigured = original;
  }
});

test('openai subscription mode: codex is a router candidate WITHOUT paying_apis_enabled, as long as the CLI reports configured', async () => {
  setRouterSettings({ openai_mode: 'subscription', paying_apis_enabled: false });
  const originalConfigured = codexProvider.isConfigured;
  const originalGenerate   = codexProvider.generate;
  codexProvider.isConfigured = async () => true;
  codexProvider.generate     = async () => ({ text: 'OK', model: 'codex/mock' });
  try {
    const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
    assert.notEqual(result, null, 'codex must be attempted (not skipped) even with paying_apis_enabled=false');
    assert.equal(result.provider, 'codex');
  } finally {
    codexProvider.isConfigured = originalConfigured;
    codexProvider.generate     = originalGenerate;
  }
});

test('openai mode exclusivity: selecting "api" mode never adds codex as a candidate, even if the CLI is configured', async () => {
  setRouterSettings({ openai_mode: 'api', paying_apis_enabled: true });
  setCloudKey('openai', '');
  const original = codexProvider.isConfigured;
  codexProvider.isConfigured = async () => true;
  try {
    const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
    assert.equal(result, null, 'codex must never be used when openai_mode is "api", regardless of CLI state');
  } finally {
    codexProvider.isConfigured = original;
  }
});

test('openai mode exclusivity: selecting "subscription" mode never adds the OpenAI API as a candidate, even with a valid key', async () => {
  setRouterSettings({ openai_mode: 'subscription', paying_apis_enabled: true });
  setCloudKey('openai', 'sk-proj-faketest123456789');
  const original = codexProvider.isConfigured;
  codexProvider.isConfigured = async () => false;
  try {
    const result = await tryCloudFallbackChain([{ role: 'user', content: 'hi' }]);
    assert.equal(result, null, 'OpenAI API must never be used as a fallback when openai_mode is "subscription"');
  } finally {
    codexProvider.isConfigured = original;
  }
});

test('default settings (fresh db): claude_mode and openai_mode default to "subscription"', async () => {
  const freshDb = './data-test-fallback/default-mode-fresh.db';
  fs.rmSync(freshDb, { force: true });
  const { initSqlite: freshInit, getRouterSettings: freshGetSettings } = await import('./src/lib/sqlite.js?cachebust=' + Date.now());
  freshInit(freshDb);
  const settings = freshGetSettings();
  assert.equal(settings.claude_mode, 'subscription');
  assert.equal(settings.openai_mode, 'subscription');
});

test('getRouterSettings: a settings row saved BEFORE claude_mode/openai_mode existed still reports their real defaults, not undefined — regression for a stale-row/new-field mismatch', async () => {
  const staleDb = './data-test-fallback/stale-settings.db';
  fs.rmSync(staleDb, { force: true });
  const { initSqlite: staleInit, setMeta: staleSetMeta, getRouterSettings: staleGetSettings } = await import('./src/lib/sqlite.js?cachebust=' + Date.now());
  staleInit(staleDb);
  // Simulate an old settings row saved before claude_mode/openai_mode existed
  staleSetMeta('router_settings', { router_enabled: true, fallback_model: 'llama3.2:3b' });
  const settings = staleGetSettings();
  assert.equal(settings.claude_mode, 'subscription');
  assert.equal(settings.openai_mode, 'subscription');
  assert.equal(settings.router_enabled, true); // stale fields still preserved
});
