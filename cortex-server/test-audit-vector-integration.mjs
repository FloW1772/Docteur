// Real installed LanceDB SDK, temporary index, deterministic vectors, no model.
import './test-setup.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertNeuron, getAllNeuronsForBackup, countNeurons } from './src/lib/lancedb.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-audit-real-vector-'));
const index = path.join(scratch, 'cortex.lance');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('real SDK inserts and atomically updates a vector without duplicate rows', async () => {
  await upsertNeuron(index, { id: 'note', title: 'Original', content: 'Original', vector: [1, 0] });
  await upsertNeuron(index, { id: 'note', title: 'Edited', content: 'Edited text', metadata: { egress_policy: 'local_only' }, vector: [0, 1] });
  assert.equal(await countNeurons(index), 1);
  const rows = await getAllNeuronsForBackup(index);
  assert.equal(rows[0].content, 'Edited text');
  assert.equal(rows[0].metadata.egress_policy, 'local_only');
});
test('Docteur rejects incompatible dimensions before real SDK conversion and preserves the saved row', async () => {
  await assert.rejects(upsertNeuron(index, { id: 'note', title: 'Bad dimension', content: 'Must not replace', vector: [0, 1, 0] }), /dimension mismatch/);
  const rows = await getAllNeuronsForBackup(index);
  assert.equal(rows.length, 1); assert.equal(rows[0].content, 'Edited text');
});

test('empty and non-finite vectors cannot replace a saved real row', async () => {
  for (const vector of [[], [NaN, 0], [Infinity, 1], [undefined, 0]]) {
    await assert.rejects(upsertNeuron(index, { id: 'note', title: 'Invalid', content: 'Must not replace', vector }), /finite numbers/);
  }
  assert.equal((await getAllNeuronsForBackup(index))[0].content, 'Edited text');
});
