// Synthetic SQLite and temporary LanceDB only; no user data or provider calls.
import './test-setup.mjs';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initSqlite, savePageToStore, getPageFromStore, createConversation,
  addConversationMessage, getAllConversationsForBackup, addPreferenceFact,
  listPreferenceFacts, getDatabase,
} from './src/lib/sqlite.js';
import { createBackupRoute } from './src/routes/backup.js';
import { runBackup } from './src/lib/backup.js';
import { parseIntParam } from './src/lib/http-params.js';
import { createNeuronRoute } from './src/routes/neuron.js';
import { restoreBackupConversation } from './src/lib/backup-snapshot.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-audit-backup-'));
const page = {
  id: 'unindexed', kind: 'note', title: 'SQLite only',
  blocks: [{ id: 'b1', type: 'paragraph', content: 'Private original text' }],
  createdAt: 100, updatedAt: 200, links: ['indexed'], tags: ['test'],
  color: '#123456', metadata: { egress_policy: 'local_only' }, private: true,
};
initSqlite(':memory:');
beforeEach(() => { getDatabase().exec('DELETE FROM pages; DELETE FROM conversation_messages; DELETE FROM conversations; DELETE FROM preference_facts;'); });
after(() => { getDatabase().close(); fs.rmSync(scratch, { recursive: true, force: true }); });
const app = (neurons = [], indexNeuron = async () => {}) => createBackupRoute({
  services: { getAllNeuronsForBackup: async () => neurons, indexNeuron }, logger: { warn() {} },
});
const post = (route, payload) => route.request('/backup/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

test('manual export includes SQLite-only pages, indexed-only rows and full page fidelity', async () => {
  savePageToStore(page);
  const response = await app([{ id: 'indexed', title: 'Index only', content: 'legacy' }]).request('/backup/export');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.neurons_count, 2);
  assert.deepEqual(data.neurons.find(n => n.id === page.id).blocks, page.blocks);
  assert.equal(data.neurons.find(n => n.id === page.id).private, true);
  assert.equal(data.neurons.find(n => n.id === 'indexed').content, 'legacy');
});

test('daily disk backup preserves SQLite-only pages, blocks, privacy, links and personal data', async () => {
  savePageToStore(page);
  createConversation('conv', 'Local chat'); addConversationMessage('conv', 'user', 'Synthetic message');
  addPreferenceFact('Synthetic preference', { privacy: true });
  const result = await runBackup(path.join(scratch, 'cortex.lance'));
  const data = JSON.parse(fs.readFileSync(path.join(scratch, 'backups', result.filename), 'utf8'));
  assert.equal(data.neurons_count, 1);
  const restored = data.neurons[0];
  for (const field of ['blocks', 'links', 'tags', 'metadata', 'private', 'color', 'createdAt', 'updatedAt'])
    assert.deepEqual(restored[field], page[field], field);
  assert.equal(data.personal_data.conversations[0].messages[0].content, 'Synthetic message');
  assert.equal(data.personal_data.preference_facts[0].privacy, 1);
});

test('restore saves original page even when embeddings are unavailable', async () => {
  const response = await post(app([], async () => { throw new Error('Ollama unavailable'); }), { version: '1.2', neurons: [page] });
  assert.equal(response.status, 200);
  assert.deepEqual(getPageFromStore(page.id)?.blocks, page.blocks);
  const result = await response.json();
  assert.equal(result.saved, 1); assert.equal(result.indexed, 0); assert.equal(result.index_pending, 1);
});

test('export/import restores conversations and preference privacy; a repeated restore is idempotent', async () => {
  createConversation('conv', 'Local chat'); addConversationMessage('conv', 'user', 'Synthetic message');
  addPreferenceFact('Synthetic preference', { privacy: true, source: 'correction', sourceRef: 'conv' });
  const exported = await (await app().request('/backup/export')).json();
  getDatabase().prepare('DELETE FROM conversation_messages').run();
  getDatabase().prepare('DELETE FROM conversations').run();
  getDatabase().prepare('DELETE FROM preference_facts').run();
  await post(app(), exported); await post(app(), exported);
  const conversations = getAllConversationsForBackup();
  assert.equal(conversations.length, 1); assert.equal(conversations[0].messages.length, 1);
  assert.equal(conversations[0].title, 'Local chat');
  const facts = listPreferenceFacts(); assert.equal(facts.length, 1);
  assert.equal(facts[0].privacy, 1); assert.equal(facts[0].egress_policy, 'local_only');
  assert.equal(facts[0].source_ref, 'conv');
});

test('fractional and unsafe pagination integers fall back rather than reaching SQLite', async () => {
  for (const value of ['1.5', '-2.5', '9007199254740992', 'Infinity'])
    assert.equal(parseIntParam(value, 50), 50, value);
  const route = createNeuronRoute({ services: {} });
  const data = await (await route.request('/neurons/recent?limit=-1')).json();
  assert.equal(data.limit, 1);
});

test('legacy backups reconstruct content, empty titles remain valid, malformed entries are reported', async () => {
  const response = await post(app(), { version: '1.1', neurons: [null, { id: 'legacy', title: '', content: 'Legacy text' }] });
  const result = await response.json();
  assert.equal(result.saved, 1); assert.equal(result.reconstructedBlocks, 1);
  assert.equal(result.ok, false); assert.equal(result.errors.length, 1);
  assert.equal(getPageFromStore('legacy').blocks[0].content, 'Legacy text');
});

test('private flags reach local indexing and current SQLite content replaces a stale index', async () => {
  savePageToStore(page);
  let indexed;
  const route = app([{ id: page.id, title: 'Old title', content: 'Stale old index' }], async payload => { indexed = payload; });
  const exported = await (await route.request('/backup/export')).json();
  assert.equal(exported.neurons.length, 1); assert.equal(exported.neurons[0].content, page.blocks[0].content);
  await post(route, exported);
  assert.equal(indexed.private, true); assert.equal(indexed.metadata.egress_policy, 'local_only');
});

test('invalid messages roll back the entire conversation without affecting existing chats', () => {
  createConversation('existing', 'Keep this'); addConversationMessage('existing', 'user', 'Original');
  assert.throws(() => restoreBackupConversation({ id: 'bad', messages: [
    { role: 'user', content: 'First valid' }, { role: 'invented', content: 'Invalid' },
  ] }), /invalide/);
  assert.deepEqual(getAllConversationsForBackup().map(c => c.id), ['existing']);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?').get('bad').n, 0);
});

test('legacy conversations without message ids are restored once; existing conversations remain unchanged', async () => {
  const payload = { version: '1.2', neurons: [], personal_data: { conversations: [
    { id: 'legacy-chat', title: 'Legacy', messages: [{ role: 'user', content: 'Old export', created_at: '2020-01-01T00:00:00Z' }] },
  ] } };
  await post(app(), payload);
  payload.personal_data.conversations[0].title = 'Overwrite attempt';
  await post(app(), payload);
  const chats = getAllConversationsForBackup();
  assert.equal(chats[0].title, 'Legacy'); assert.equal(chats[0].messages.length, 1);
});

test('two backups in the same process produce valid atomic JSON and no temporary leftovers', async () => {
  savePageToStore(page);
  const results = await Promise.all([runBackup(path.join(scratch, 'cortex.lance')), runBackup(path.join(scratch, 'cortex.lance'))]);
  const files = fs.readdirSync(path.join(scratch, 'backups'));
  assert.equal(files.filter(name => name.includes('.tmp-')).length, 0);
  assert.equal(results[0].filename, results[1].filename);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, 'backups', results[0].filename), 'utf8')).neurons_count, 1);
});

test('malformed JSON is a client error, without modifying saved pages', async () => {
  savePageToStore(page);
  const response = await app().request('/backup/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(getPageFromStore(page.id), page);
});
