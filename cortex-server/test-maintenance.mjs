// Mock-only maintenance regression: no real credentials or user database.
import './test-setup.mjs';
import assert from 'node:assert/strict';
import { Ollama } from 'ollama';
import { initSqlite, setCloudKey, setRouterSettings } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { needsCompaction } from './src/lib/lancedb.js';
assert.equal(needsCompaction({ numFragments: 182, diskBytes: 11111887083, totalBytes: 24484404 }), true);
assert.equal(needsCompaction({ numFragments: 1, diskBytes: 24352313, totalBytes: 24352313 }), false);
assert.equal(needsCompaction({ numFragments: 1000, diskBytes: 1, totalBytes: 1 }), true);
assert.equal(needsCompaction(null), false);
assert.equal(process.argv.includes('--live'), false, 'This regression suite is mock-only');
const keys = { gemini_key: 'fake-maintenance-gemini', groq_key: 'fake-maintenance-groq', openrouter_key: 'fake-maintenance-openrouter' };
initSqlite(':memory:');
let calledLocalModel;
const mockOllama = {
  list: async () => ({ models: [{ name: 'dedicated:latest' }] }),
  chat: async ({ model }) => { calledLocalModel = model; return { message: { content: '[{"title":"Fractions","summary":"Introduction"}]' } }; },
};
const route = createTeacherRoute({ services: {}, ollamaClient: process.argv.includes('--live') ? new Ollama() : mockOllama, logger: { warn() {}, error() {} } });
const request = async (url, body) => {
  const r = await route.request(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, body: await r.json() };
};
let available = (await request('/teacher/available-models')).body;
for (const section of Object.values(available.cloud)) {
  assert.equal(section.available, false);
  assert.ok(section.models.every(m => m.disabled_reason));
}
for (const [key, value] of Object.entries(keys)) setCloudKey(key.replace('_key', ''), value);
setRouterSettings({ strict_local_mode: true });
available = (await request('/teacher/available-models')).body;
for (const section of Object.values(available.cloud)) assert.equal(section.available, false);
assert.equal((await request('/teacher/settings/validate', { model: 'gemini:gemini-2.5-flash' })).body.ok, false);
setRouterSettings({ strict_local_mode: false });
available = (await request('/teacher/available-models')).body;
console.log('CONFIGURATION', JSON.stringify({ strictLocal: available.strict_local_mode, providers: Object.fromEntries(Object.entries(available.cloud).map(([p, s]) => [p, { configured: s.configured, models: s.models.length }])) }));
if (!process.argv.includes('--live')) {
  assert.equal((await request('/teacher/settings/validate', { model: 'dedicated:latest' })).body.ok, true);
  await request('/teacher/settings', { model: 'dedicated:latest' });
  // A "local" Teacher model setting only tells resolveEffectiveTeacherModel
  // to route to Ollama — the actual model string used for the completion
  // call comes from the router's own chat_model setting instead
  // (callLocalTeacherModel, routes/teacher.js), which is a separate,
  // independent setting. Configure it explicitly here — on this test's own
  // :memory: DB, never the real one — so this assertion verifies the real
  // contract (chat_model drives the local call) instead of assuming the
  // Teacher model string does, and stays deterministic regardless of
  // whatever chat_model default happens to exist.
  setRouterSettings({ chat_model: 'dedicated:latest' });
  assert.equal((await request('/teacher/paths', { subject: 'Fractions' })).status, 201);
  assert.equal(calledLocalModel, 'dedicated:latest');
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url).split('?')[0]);
    return Response.json({ candidates: [{ content: { parts: [{ text: '[{"title":"Fractions"}]' }] } }] });
  };
  try {
    const model = 'gemini:gemini-2.5-flash';
    assert.equal((await request('/teacher/settings/validate', { model })).body.ok, true);
    await request('/teacher/settings', { model });
    assert.equal((await request('/teacher/paths', { subject: 'Fractions' })).status, 201);
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.endsWith('/gemini-2.5-flash:generateContent')));
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await request('/teacher/settings/validate', { model: 'openrouter:unsupported' })).body.ok, false);
}
if (process.argv.includes('--live')) {
  for (const [provider, section] of Object.entries(available.cloud)) {
    if (!section.configured) continue;
    const id = section.models[0].id;
    const model = id.startsWith(provider + ':') ? id : provider + ':' + id;
    const test = await request('/teacher/settings/validate', { model });
    console.log('VALIDATE', provider, JSON.stringify(test));
    if (!test.body.ok) continue;
    await request('/teacher/settings', { model });
    const plan = await request('/teacher/paths', { subject: 'Comprendre les fractions simples' });
    console.log('PLAN', provider, JSON.stringify({ status: plan.status, model: plan.body.model_used, steps: plan.body.path?.plan?.length, error: plan.body.error }));
    if (!plan.body.path) continue;
    const started = await request(`/teacher/paths/${plan.body.path.id}/start`, {});
    const stepId = started.body.steps[0].id;
    const explain = await request(`/teacher/paths/${plan.body.path.id}/steps/${stepId}/explain`, {});
    console.log('EXPLAIN', provider, JSON.stringify({ status: explain.status, model: explain.body.model_used, length: explain.body.step?.content?.length, error: explain.body.error }));
  }
}
console.log('Configuration assertions passed; no production settings or paths modified.');
