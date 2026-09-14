import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { initSqlite, savePageToStoreIfNewer } from './src/lib/sqlite.js';
import { createNeuronRoute } from './src/routes/neuron.js';

initSqlite(':memory:');
for (let i = 0; i < 10; i++) {
  savePageToStoreIfNewer({
    id: `meta-fixture-${i}`, title: `Fixture ${i}`, kind: 'note',
    blocks: [{ id: `b-${i}`, type: 'paragraph', content: 'x' }],
    links: [], createdAt: i + 1, updatedAt: i + 1, metadata: {},
  });
}

test('/neurons/all-meta: response shape unchanged (ok + pages array), no pagination params required', async () => {
  const app = createNeuronRoute({ services: {} });
  const res = await app.request('/neurons/all-meta');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.pages.length, 10);
  assert.equal(Object.keys(body).sort().join(','), 'ok,pages');
});

test('/neurons/all-meta: does not log timing for a small, fast dataset', async () => {
  const logCalls = [];
  const app = createNeuronRoute({ services: {}, logger: { info: (...args) => logCalls.push(args) } });
  await app.request('/neurons/all-meta');
  assert.equal(logCalls.length, 0);
});
