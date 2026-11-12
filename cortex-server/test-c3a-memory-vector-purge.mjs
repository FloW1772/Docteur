// C3a — Docteur Memory (NB-5): a vector the store fails to delete is no longer silently ignored.
// delete / revoke / edit report vectorPurge: 'DONE' | 'PENDING'; a PENDING purge is recorded in the content-free audit
// (ids only) and retried by sweepRetention (boot, retention job, before retrieval) until the store accepts it. An
// orphan vector is never used as a valid memory, and a vector that belongs again to a live, re-indexed memory is
// never deleted by the retry.
// Run: node --test test-c3a-memory-vector-purge.mjs
//
// Isolation: temporary database only (never the real one), in-memory vector store with a switchable delete failure,
// deterministic fake embeddings, no Ollama, no LanceDB, no network, no server.
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { ensureMemorySchema } from './src/lib/notebook-memory-schema.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-c3a-'));
const DIM = 32;
function fakeEmbed(text) {
  const v = new Array(DIM).fill(0);
  for (const w of String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n);
}
const embed = async (t) => fakeEmbed(String(t).replace(/^search_(document|query): /, ''));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// In-memory vector store; `failDelete` makes every delete throw like an unavailable LanceDB.
function flakyVectors() {
  const rows = new Map();
  const store = {
    rows, failDelete: false, deleteCalls: 0,
    upsert: async (l) => { for (const r of l) rows.set(r.memory_id, { ...r }); },
    search: async (v, { limit }) => [...rows.values()].map((r) => ({ memory_id: r.memory_id, scope_kind: r.scope_kind, project_id: r.project_id, notebook_id: r.notebook_id, score: dot(r.vector, v) }))
      .sort((a, b) => b.score - a.score).slice(0, limit),
    delete: async (ids) => { store.deleteCalls += 1; if (store.failDelete) throw new Error('vector store unavailable'); for (const i of ids) rows.delete(i); },
  };
  return store;
}

const DMEM = ['dmem_evidence', 'dmem_revisions', 'dmem_conflicts', 'dmem_suggestions', 'dmem_usage', 'dmem_audit', 'dmem_embeddings', 'dmem_items_fts', 'dmem_items', 'dmem_notebook_projects', 'dmem_projects'];
const db = () => getDatabase();
const logs = [];
const logger = { info: (o, m) => logs.push(JSON.stringify([o, m])), warn: (o, m) => logs.push(JSON.stringify([o, m])), error: (o, m) => logs.push(JSON.stringify([o, m])) };
function service(vec, { sessionId = 'c3a-session' } = {}) {
  return createMemoryService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: vec, sessionId, logger, localComplete: async () => 'ok' });
}
async function fresh() {
  ensureMemorySchema(db());
  for (const t of DMEM) db().prepare(`DELETE FROM ${t}`).run();
  const vec = flakyVectors();
  const mem = service(vec);
  await mem.ready;
  mem.createProject({ projectId: 'c3a', name: 'C3a' });
  return { vec, mem };
}
const STATEMENT = 'Le port du serveur de synchronisation C3a est fixé à 4815.';
const create = (mem, statement = STATEMENT) => mem.createManual({ type: 'DECISION', scope: { kind: 'PROJECT', projectId: 'c3a' }, statement });
const pendingIds = () => db().prepare(`SELECT DISTINCT memory_id FROM dmem_audit p WHERE action = 'VECTOR_PURGE_PENDING'
  AND NOT EXISTS (SELECT 1 FROM dmem_audit d WHERE d.memory_id = p.memory_id AND d.action = 'VECTOR_PURGE_DONE' AND d.audit_id > p.audit_id)`).all().map((r) => r.memory_id);
const found = async (mem, id, q = 'port serveur synchronisation C3a 4815') => (await mem.retrieve(q, { activeProject: 'c3a' })).results.some((r) => r.memoryId === id);

before(() => { initSqlite(path.join(TMP, 'c3a.db')); });
after(() => { try { getDatabase().close(); } catch { /* ignore */ } fs.rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { logs.length = 0; });

test('successful delete: vectorPurge DONE, vector gone, nothing pending', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  assert.equal(vec.rows.has(id), true);
  assert.deepEqual(await mem.deleteMemory(id), { ok: true, vectorPurge: 'DONE' });
  assert.equal(vec.rows.has(id), false);
  assert.deepEqual(pendingIds(), []);
});

test('failed delete is reported (PENDING), recorded with ids only, and the SQL purge still completes', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  vec.failDelete = true;
  assert.deepEqual(await mem.deleteMemory(id), { ok: true, vectorPurge: 'PENDING' });
  assert.equal(mem.getMemory(id), null);
  assert.equal(vec.rows.has(id), true, 'the orphan vector is still in the store');
  assert.deepEqual(pendingIds(), [id]);
  const dump = JSON.stringify(db().prepare('SELECT * FROM dmem_audit').all()) + logs.join('\n');
  assert.doesNotMatch(dump, /synchronisation|4815/, 'audit and logs never hold the statement');
});

test('an orphan vector is never used as a valid memory', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  assert.equal(await found(mem, id), true, 'retrievable before deletion');
  vec.failDelete = true;
  await mem.deleteMemory(id);
  const raw = await vec.search(await embed('port serveur synchronisation C3a 4815'), { limit: 5 });
  assert.ok(raw.some((r) => r.memory_id === id), 'the store still returns the orphan');
  assert.equal(await found(mem, id), false, 'retrieval never returns it');
});

test('the retry purges a pending orphan once the store is back, and is idempotent', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  vec.failDelete = true;
  await mem.deleteMemory(id);
  const stillDown = await mem.sweepRetention();
  assert.equal(stillDown.vectorPurgePending, 1);
  assert.equal(vec.rows.has(id), true);
  vec.failDelete = false;
  const r = await mem.sweepRetention();
  assert.equal(r.vectorPurged, 1);
  assert.equal(r.vectorPurgePending, 0);
  assert.equal(vec.rows.has(id), false);
  assert.deepEqual(pendingIds(), []);
  const calls = vec.deleteCalls;
  assert.equal((await mem.sweepRetention()).vectorPurged, 0, 'nothing left to retry');
  assert.equal(vec.deleteCalls, calls);
});

test('revoke with a failed delete: PENDING, the revoked memory is never retrieved, the retry purges it', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  vec.failDelete = true;
  const r = await mem.revoke(id);
  assert.equal(r.vectorPurge, 'PENDING');
  assert.equal(r.memory.status, 'REVOKED');
  assert.equal(await found(mem, id), false);
  vec.failDelete = false;
  await mem.sweepRetention();
  assert.equal(vec.rows.has(id), false);
  assert.equal(mem.getMemory(id).status, 'REVOKED', 'the memory itself is kept (revoke is not delete)');
});

test('edit with a failed old-vector delete: the re-indexed vector is kept by the retry, never deleted', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  vec.failDelete = true;
  const r = await mem.edit(id, { statement: 'Le port du serveur de synchronisation C3a est désormais 2342.' });
  assert.equal(r.vectorPurge, 'PENDING');
  assert.equal(r.vector, 'READY', 'the new vector replaced the old one');
  vec.failDelete = false;
  const calls = vec.deleteCalls;
  const s = await mem.sweepRetention();
  assert.equal(s.vectorPurged, 1, 'resolved');
  assert.equal(vec.deleteCalls, calls, 'no delete of a vector that belongs to a live memory');
  assert.equal(vec.rows.has(id), true);
  assert.equal(await found(mem, id, 'port serveur synchronisation C3a 2342'), true);
  assert.deepEqual(pendingIds(), []);
});

test('restart safety: a new service instance picks up pending purges at boot', async () => {
  const { vec, mem } = await fresh();
  const id = (await create(mem)).memory.memoryId;
  vec.failDelete = true;
  await mem.deleteMemory(id);
  mem.stopRetentionJob();
  vec.failDelete = false;
  const restarted = service(vec, { sessionId: 'c3a-session' });
  await restarted.ready;
  assert.equal(vec.rows.has(id), false);
  assert.deepEqual(pendingIds(), []);
});
