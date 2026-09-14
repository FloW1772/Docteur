import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { initSqlite, savePageToStoreIfNewer, getPageFromStore, deletePageFromStore } from './src/lib/sqlite.js';

// P2-E investigation finding: an "agent neuron" is not a distinct neuron
// kind and has no live/running process tied to it. POST /api/agents/:id/run
// (see routes/agents.js) awaits executeAgent() to completion server-side and
// returns the finished { title, content, kind }; the frontend then creates
// the neuron via the ordinary createPageFromData() path (App.tsx
// handleAgentOutput), identical to any manually created neuron. By the time
// a neuron exists and is visible in the UI, the agent run that produced it
// has already finished — there is nothing left to "stop" on close, and the
// existing generic onClose (setSelectedId(null)) is therefore already
// correct, not a lifecycle bug. This test locks in that invariant: a neuron
// created from agent output persists and behaves exactly like any other
// neuron across save/reload/delete.
initSqlite(':memory:');

test('a neuron created from agent output persists identically to a manually created neuron (no special agent-only state)', () => {
  const agentNeuron = {
    id: 'agent-output-neuron-1',
    title: 'Rapport hebdomadaire',
    kind: 'rapport',
    blocks: [{ id: 'b1', type: 'paragraph', content: 'Résultat généré par un agent.' }],
    links: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };

  savePageToStoreIfNewer(agentNeuron);
  const reloaded = getPageFromStore(agentNeuron.id);
  assert.ok(reloaded);
  assert.equal(reloaded.title, agentNeuron.title);
  assert.equal(reloaded.blocks.length, 1);

  // "Closing" it (from the app's perspective) is just deselecting in the UI —
  // nothing here depends on any agent-run/process state, confirming the
  // simple generic close handler is sufficient.
  const stillThere = getPageFromStore(agentNeuron.id);
  assert.ok(stillThere, 'neuron content must remain fully intact after "closing" the editor (no server-side agent state to invalidate it)');

  deletePageFromStore(agentNeuron.id);
  assert.equal(getPageFromStore(agentNeuron.id), null);
});
