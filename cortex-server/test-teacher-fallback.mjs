import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, setCloudKey } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: false, chat_model: 'test-local-model' });
setCloudKey('openrouter', 'test-openrouter-key');
setCloudKey('groq', 'test-groq-key');
setCloudKey('gemini', 'test-gemini-key');

// Regression test for a real bug observed live: OpenRouter's free tier
// (nvidia/nemotron-3-super-120b-a12b:free) occasionally returns HTTP 200
// with an empty choices[0].message.content (classified as ErrorCategory
// UNKNOWN, "OpenRouter: réponse vide" — see providers/openrouter.js) instead
// of a real explanation. Before the fix, this made the whole learning step
// fail with a 503 even though a working local model (Ollama) was available.
// Fixed in teacher.js: callTeacherModel now retries once against the local
// model for UNKNOWN/PROVIDER_UNAVAILABLE/TIMEOUT/NETWORK_ERROR categories —
// but never for AUTH_FAILED/QUOTA_EXCEEDED, which still need the user to act.

const ollamaClient = {
  chat: async ({ model }) => ({ message: { content: `local answer from ${model}` } }),
};

const app = new Hono();
app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));

test.afterEach(() => {
  globalThis.fetch = undefined;
  setRouterSettings({ strict_local_mode: false, chat_model: 'test-local-model' });
});

async function createAndStartPath(planResponse) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) {
      return new Response(JSON.stringify(planResponse), { status: 200 });
    }
    throw new Error(`unexpected fetch in setup: ${url}`);
  };
  await import('./src/lib/sqlite.js').then(m => m.setTeacherSettings({ model: 'openrouter:nvidia/nemotron-3-super-120b-a12b:free' }));
  const planRes = await app.request('/api/teacher/paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: '__E2E_TEST__ fallback subject' }),
  });
  const { path } = await planRes.json();
  const startRes = await app.request(`/api/teacher/paths/${path.id}/start`, { method: 'POST' });
  const { steps } = await startRes.json();
  return { path, step: steps[0] };
}

test('explain falls back to local Ollama when OpenRouter returns an empty response (UNKNOWN category)', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  // Now OpenRouter returns 200 with empty content — the real bug scenario.
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 200, 'must succeed via local fallback, not fail the step');
  const body = await res.json();
  assert.ok(body.step.content.startsWith('local answer from'), 'content must come from the local fallback');
  assert.equal(body.forced_local, true);
  // Transparency: the response must say OpenRouter was requested but the
  // local model actually answered — never silently imply OpenRouter answered.
  assert.equal(body.requested_provider, 'openrouter');
  assert.equal(body.model_used.startsWith('local/'), true);
  assert.equal(body.fallback_reason_code, 'unknown'); // OpenRouter's empty-response error is category UNKNOWN
  assert.equal(body.fallback_reason, 'Le fournisseur cloud n\'a pas produit de réponse exploitable');
  assert.notEqual(body.fallback_reason_code, 'strict_local'); // this was a runtime failure, not a Strict Local block
});

test('fallback_reason never leaks the raw upstream provider error text (sanitization)', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  // A provider error message that could plausibly contain sensitive-looking
  // content an upstream provider chose to echo back (URLs, fragments, etc.).
  const sensitiveRawMessage = 'internal debug: request_id=abc123 upstream=https://internal.example/secret?token=xyz789 stack=at foo.js:42';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: sensitiveRawMessage } }), { status: 503 });

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 200); // 503 from OpenRouter -> PROVIDER_UNAVAILABLE -> retried locally
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('internal.example'), false);
  assert.equal(serialized.includes('token=xyz789'), false);
  assert.equal(serialized.includes('request_id'), false);
  assert.equal(serialized.includes('stack='), false);
  assert.equal(body.fallback_reason_code, 'provider_unavailable');
  assert.equal(body.fallback_reason, 'Le fournisseur cloud est actuellement indisponible');
});

test('explain does NOT fall back to local on a quota error — surfaces it to the user instead', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'insufficient_quota, billing required' } }), { status: 429 });

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.quota_hit, true);
  assert.ok(!body.step); // never silently answered from local when it's a quota problem
});

test('explain does NOT fall back to local on an auth error — surfaces it to the user instead', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error);
  assert.ok(!body.step);
});

// ── Sanitization coverage across every Teacher endpoint that surfaces a
// provider error to the frontend. Each injects the same synthetic
// adversarial payload the mission specified: an internal URL, a fake token,
// a stack-trace-shaped fragment, and raw provider wording — and asserts none
// of it appears anywhere in the JSON response, only the fixed sanitized
// labels from OPERATION_ERROR_LABELS/FALLBACK_REASON_LABELS.

const SENSITIVE_PAYLOAD = 'internal debug: request_id=abc123 upstream=https://internal.example/secret?token=xyz789 Authorization: Bearer sk-live-FAKETOKEN1234567890 stack=at foo.js:42:7\n    at bar (baz.js:10:3)';
const SENSITIVE_FRAGMENTS = ['internal.example', 'token=xyz789', 'FAKETOKEN', 'request_id', 'stack=', 'Authorization', 'Bearer', 'baz.js'];

function assertNoLeak(body) {
  const serialized = JSON.stringify(body);
  for (const fragment of SENSITIVE_FRAGMENTS) {
    assert.equal(serialized.includes(fragment), false, `leaked fragment: ${fragment}`);
  }
}

test('POST /teacher/paths (plan) sanitizes a raw provider error — 401 AUTH_FAILED', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: SENSITIVE_PAYLOAD } }), { status: 401 });
  await import('./src/lib/sqlite.js').then(m => m.setTeacherSettings({ model: 'openrouter:nvidia/nemotron-3-super-120b-a12b:free' }));

  const res = await app.request('/api/teacher/paths', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: '__E2E_TEST__ sanitization plan' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assertNoLeak(body);
  assert.equal(body.error, 'Échec de la génération du plan : Authentification refusée par ce fournisseur cloud — vérifie la clé API dans Paramètres.');
});

test('POST /teacher/paths/:id/steps/:id/explain sanitizes a raw provider error when no fallback applies — 401 AUTH_FAILED', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: SENSITIVE_PAYLOAD } }), { status: 401 });

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assertNoLeak(body);
  assert.equal(body.error, 'Échec de l\'explication : Authentification refusée par ce fournisseur cloud — vérifie la clé API dans Paramètres.');
});

test('POST /teacher/paths/:id/steps/:id/answer sanitizes a raw provider error when no fallback applies — 401 AUTH_FAILED', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Real explanation text.' } }] }), { status: 200 });
  await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: SENSITIVE_PAYLOAD } }), { status: 401 });
  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: '__E2E_TEST__ my answer' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assertNoLeak(body);
  assert.equal(body.error, 'Échec de l\'évaluation : Authentification refusée par ce fournisseur cloud — vérifie la clé API dans Paramètres.');
});

test('POST /teacher/paths/:id/recap sanitizes a raw provider error — 401 AUTH_FAILED', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Real explanation text.' } }] }), { status: 200 });
  await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/advance`, { method: 'POST' }).catch(() => {});

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: SENSITIVE_PAYLOAD } }), { status: 401 });
  const res = await app.request(`/api/teacher/paths/${path.id}/recap`, { method: 'POST' });
  const body = await res.json();
  assertNoLeak(body);
  if (res.status === 503) {
    assert.equal(body.error, 'Échec de la génération de la fiche : Authentification refusée par ce fournisseur cloud — vérifie la clé API dans Paramètres.');
  }
});

test('POST /teacher/settings/validate sanitizes a raw provider error — 401 AUTH_FAILED', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: SENSITIVE_PAYLOAD } }), { status: 401 });
  const res = await app.request('/api/teacher/settings/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openrouter:nvidia/nemotron-3-super-120b-a12b:free' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assertNoLeak(body);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Authentification refusée par ce fournisseur cloud — vérifie la clé API dans Paramètres.');
});

test('explain succeeds normally when OpenRouter returns real content (no fallback triggered)', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Real explanation text.' } }], model: 'nvidia/nemotron-3-super-120b-a12b:free' }), { status: 200 });

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.step.content, 'Real explanation text.');
  assert.equal(body.forced_local, false);
  assert.equal(body.requested_provider, 'openrouter');
  assert.equal(body.fallback_reason_code, null); // no fallback happened — must not fabricate a reason
  assert.equal(body.fallback_reason, null);
  assert.equal(body.model_used.startsWith('openrouter'), true);
});

test('explain reports fallback_reason "strict_local" when Strict Local blocks the cloud call before any attempt', async () => {
  const planJson = { choices: [{ message: { content: JSON.stringify([{ title: 'Étape 1', summary: 'Résumé' }]) } }] };
  const { path, step } = await createAndStartPath(planJson);

  setRouterSettings({ strict_local_mode: true });
  globalThis.fetch = async () => { throw new Error('must never call the network under Strict Local'); };

  const res = await app.request(`/api/teacher/paths/${path.id}/steps/${step.id}/explain`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.forced_local, true);
  assert.equal(body.requested_provider, 'openrouter');
  assert.equal(body.fallback_reason_code, 'strict_local');
  assert.equal(body.fallback_reason, 'Mode Strict Local actif');
  assert.equal(body.model_used.startsWith('local/'), true);
});
