import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';

async function fixture(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-final-vectors-'));
  const index = path.join(scratch, 'index.lance');
  const api = await import(`./src/lib/lancedb.js?review=${encodeURIComponent(scratch)}`);
  try { await run(api, index); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

for (const kind of ['neurons', 'notebook_chunks', 'docteur_memory']) {
  const row = i => ({ id: `n${i}`, title: `N ${i}`, content: 'Fixture', vector: [1, 0],
    chunk_id: `c${i}`, notebook_id: 'nb', source_id: 's', version_id: 'v', memory_id: `m${i}`, scope_kind: 'GLOBAL' });
  const put = (api, index, r) => kind === 'neurons' ? api.upsertNeuron(index, r)
    : kind === 'notebook_chunks' ? api.upsertChunkVectors(index, [r]) : api.upsertMemoryVectors(index, [r]);
  test(`${kind}: concurrent cold inserts all persist, without a createTable race`, () => fixture(async (api, index) => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => put(api, index, row(i))));
    assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), []);
    const table = await (await connect(index)).openTable(kind);
    assert.equal(await table.countRows(), 8);
  }));
  test(`${kind}: incompatible dimensions and float32 overflow preserve the actual stored vector`, () => fixture(async (api, index) => {
    await put(api, index, row(0));
    for (const vector of [[1, 0, 1], [Number.MAX_VALUE, 0]]) {
      await assert.rejects(put(api, index, { ...row(0), vector }), /dimension|finite|float32/i);
      const table = await (await connect(index)).openTable(kind);
      const rows = await table.query().toArray();
      assert.equal(rows.length, 1);
      assert.deepEqual(Array.from(rows[0].vector), [1, 0]);
    }
  }));
}
