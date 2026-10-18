import './test-setup.mjs';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { initSqlite, getDatabase, savePageToStore, getPageFromStore } from './src/lib/sqlite.js';
import { createBackupRoute } from './src/routes/backup.js';

initSqlite(':memory:');
beforeEach(() => getDatabase().exec('DELETE FROM pages; DELETE FROM todo_items; DELETE FROM generated_prompts;'));
after(() => getDatabase().close());
const original = { id: 'existing', title: 'Keep', kind: 'note', blocks: [{ id: 'b', type: 'paragraph', content: 'Important original' }], createdAt: 1, updatedAt: 2 };
function route() {
  const indexed = [];
  return { indexed, app: createBackupRoute({ services: { indexNeuron: async n => indexed.push(n) } }) };
}
const post = (app, data) => app.request('/backup/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '1.2', neurons: [], ...data }) });

test('invalid backup blocks never overwrite originals or enter the vector index', async () => {
  for (const blocks of [[null], [{ id: 'x', type: 'paragraph', content: {} }]]) {
    savePageToStore(original);
    const { app, indexed } = route();
    const data = await (await post(app, { neurons: [{ ...original, blocks }] })).json();
    assert.equal(data.ok, false);
    assert.equal(data.saved, 0);
    assert.equal(data.errors.length, 1);
    assert.deepEqual(getPageFromStore(original.id), original);
    assert.deepEqual(indexed, []);
  }
});

test('malformed optional page fields cannot poison metadata and the editor', async () => {
  for (const updates of [{ kind: 'unknown' }, { links: [null] }, { tags: [{}] }, { metadata: [] }, { updatedAt: 'tomorrow' }, { private: 'false' }]) {
    const { app } = route();
    const data = await (await post(app, { neurons: [{ ...original, ...updates }] })).json();
    assert.equal(data.saved, 0, JSON.stringify(updates));
    assert.equal(data.ok, false);
    assert.equal(getPageFromStore(original.id), null);
  }
});

test('failed todo/prompt insertions are reported; duplicate ids alone are skipped', async () => {
  const { app } = route();
  const malformed = await (await post(app, { todo_items: [{ id: 'todo', type: 'capture', priority: {} }], generated_prompts: { prompts: [{ id: 'prompt', request: {}, draft_text: 'Draft' }] } })).json();
  assert.equal(malformed.ok, false);
  assert.equal(malformed.errors.length, 2);
  const payload = { todo_items: [{ id: 'todo', type: 'capture', title: 'Valid' }], generated_prompts: { prompts: [{ id: 'prompt', request: 'Valid', draft_text: 'Draft' }] } };
  const first = await (await post(app, payload)).json();
  assert.equal(first.ok, true); assert.equal(first.restoredTodos, 1); assert.equal(first.restoredPrompts, 1);
  const second = await (await post(app, payload)).json();
  assert.equal(second.ok, true); assert.equal(second.restoredTodos, 0); assert.equal(second.restoredPrompts, 0);
});
