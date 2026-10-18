import './test-setup.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let existing = { id: 'note', content: 'Original vector row' };
let deleted = 0;
let openError;
const table = {
  schema: async () => ({ fields: [{ name: 'vector', type: { listSize: 2 } }] }),
  mergeInsert: () => ({ whenMatchedUpdateAll() { return this; }, whenNotMatchedInsertAll() { return this; },
    execute: async () => { throw new Error('schema mismatch'); } }),
  delete: async () => { deleted++; existing = undefined; },
  add: async () => { throw new Error('schema mismatch'); },
  query: () => ({ toArray: async () => { throw new Error('index read failure'); } }),
};
mock.module('@lancedb/lancedb', { namedExports: { connect: async () => ({ openTable: async () => {
  if (openError) throw openError;
  return table;
} }) } });
const lib = await import('./src/lib/lancedb.js');

test('a failed vector upsert preserves the previous row', async () => {
  await assert.rejects(lib.upsertNeuron('.tmp/audit-fake.lance', { id: 'note', content: 'Replacement', vector: [1, 0] }), /schema mismatch/);
  assert.equal(deleted, 0); assert.equal(existing.content, 'Original vector row');
});
test('a failed backup read is reported rather than returned as a successful empty export', async () => {
  await assert.rejects(lib.getAllNeuronsForBackup('.tmp/audit-fake.lance'), /index read failure/);
});
test('opening an unreadable index is not treated as an absent table', async () => {
  openError = new Error('permission denied');
  const fresh = await import('./src/lib/lancedb.js?audit-unreadable');
  await assert.rejects(fresh.getAllNeuronsForBackup('.tmp/audit-fake.lance'), /permission denied/);
});
test('a genuinely absent table remains a valid empty index', async () => {
  openError = new Error("Table 'neurons' was not found");
  const fresh = await import('./src/lib/lancedb.js?audit-absent');
  assert.deepEqual(await fresh.getAllNeuronsForBackup('.tmp/audit-fake.lance'), []);
});
