import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import * as provider from './src/lib/providers/freellmapi.js';

const config = { baseUrl: 'https://gateway.test/v1', apiKey: 'secret-key', timeout: 1000 };
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  provider.clearModelsCache();
});

test('discovers and normalizes advertised models without inventing fields', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://gateway.test/v1/models');
    return new Response(JSON.stringify({ data: [
      { id: 'free-text', backend: 'local-a', capabilities: ['text'], free: true, context_length: 8192 },
      { id: 'opaque' },
    ]}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const models = await provider.listModels(config);
  assert.deepEqual(models[0], {
    id: 'free-text', displayName: 'free-text', provider: 'local-a',
    capabilities: ['text'], free: true, contextLength: 8192,
  });
  assert.deepEqual(models[1], { id: 'opaque', displayName: 'opaque', capabilities: [] });
});

test('performs an OpenAI-compatible text request and never sends auto as a model', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://gateway.test/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer secret-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, undefined);
    return new Response(JSON.stringify({ model: 'backend-model', choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  };
  const result = await provider.complete({ config, model: 'auto', messages: [{ role: 'user', content: 'OK' }] });
  assert.equal(result.text, 'OK');
  assert.equal(result.model, 'backend-model');
});

test('maps authentication and rate-limit failures without exposing the key', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid credential secret-key' } }), { status: 401 });
  const auth = await provider.testConnection(config);
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 'auth_required');
  assert.equal(auth.error.includes('secret-key'), false);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 });
  const limited = await provider.testConnection(config);
  assert.equal(limited.status, 'rate_limited');
});

test('maps upstream outage and timeout health states', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'backend unavailable' } }), { status: 503 });
  const unavailable = await provider.testConnection(config);
  assert.equal(unavailable.status, 'degraded');

  globalThis.fetch = async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; };
  const timeout = await provider.testConnection(config);
  assert.equal(timeout.status, 'timeout');
});

test('does not claim multimodal support when the gateway does not advertise it', () => {
  assert.equal(provider.capabilities.has('image'), false);
  assert.equal(provider.capabilities.has('video'), false);
  assert.equal(provider.capabilities.has('audio'), false);
});

test('auto mode leaves model selection to the gateway', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://gateway.test/v1/chat/completions');
    assert.equal(JSON.parse(init.body).model, undefined);
    return new Response(JSON.stringify({ model: 'selected-by-gateway', choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  };
  const result = await provider.complete({ config, model: 'auto', messages: [{ role: 'user', content: 'OK' }] });
  assert.equal(result.model, 'selected-by-gateway');
});

test('health reports unconfigured state without making a network request', async () => {
  globalThis.fetch = async () => { throw new Error('network call should not happen'); };
  const health = await provider.getHealth({ baseUrl: 'https://gateway.test/v1' });
  assert.equal(health.status, 'auth_required');
  assert.equal(health.configured, false);
});
