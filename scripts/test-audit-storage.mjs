import test, { mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const local = new Map();
mock.module('idb-keyval', { namedExports: {
  createStore: () => ({}), get: async id => local.get(id),
  set: async (id, page) => local.set(id, structuredClone(page)),
  del: async id => local.delete(id), entries: async () => [...local.entries()],
  setMany: async pairs => { for (const [id, page] of pairs) local.set(id, page); },
} });
globalThis.window = { location: { protocol: 'http:', hostname: '127.0.0.1' } };
const output = new URL('../.tmp/audit-storage-module.mjs', import.meta.url);
const source = fs.readFileSync(new URL('../src/lib/storage.ts', import.meta.url), 'utf8');
fs.mkdirSync(new URL('../.tmp/', import.meta.url), { recursive: true });
fs.writeFileSync(output, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const storage = await import(output.href);
beforeEach(() => { local.clear(); mock.restoreAll(); window.location.hostname = '127.0.0.1'; });
after(() => { mock.restoreAll(); fs.rmSync(output, { force: true }); delete globalThis.window; });
const page = { id: 'p1', title: 'Original', blocks: [], createdAt: 1, updatedAt: 2 };

test('deleting a page waits for its in-flight save and cannot resurrect it', async () => {
  const events = []; let release; let remote;
  const slow = new Promise(resolve => { release = resolve; });
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'PUT') { events.push('PUT-start'); await slow; remote = JSON.parse(options.body).page; events.push('PUT-done'); }
    else { events.push('DELETE'); remote = undefined; }
    return new Response('{}');
  });
  const saved = storage.savePage(page, true);
  await new Promise(resolve => setImmediate(resolve));
  const deleted = storage.deletePage(page.id);
  await new Promise(resolve => setImmediate(resolve));
  release(); await Promise.all([saved, deleted]);
  assert.deepEqual(events, ['PUT-start', 'PUT-done', 'DELETE']);
  assert.equal(remote, undefined); assert.equal(local.has(page.id), false);
});

test('flushing also awaits a write whose debounce has already fired', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mock.method(globalThis, 'fetch', async () => { await gate; return new Response('{}'); });
  const saved = storage.savePage(page, true);
  await new Promise(resolve => setImmediate(resolve));
  let completed = false;
  const flushed = storage.waitForPageWrites().then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await Promise.all([saved, flushed]);
  assert.equal(completed, true);
});

test('migration reports only acknowledged batches and rejects an HTTP failure', async () => {
  for (let i = 0; i < 21; i++) local.set(String(i), { ...page, id: String(i) });
  let calls = 0; const progress = [];
  mock.method(globalThis, 'fetch', async () => new Response('{}', { status: ++calls === 1 ? 200 : 500 }));
  await assert.rejects(storage.exportAllToServer((...args) => progress.push(args)), /500/);
  assert.deepEqual(progress, [[20, 21]]);
});

test('IPv6 loopback retains local offline editing semantics', () => {
  window.location.hostname = '[::1]'; assert.equal(storage.isRemoteAccess(), false);
});

test('page ids are encoded as a single URL path segment for writes and deletes', async () => {
  const urls = []; const id = 'a/b ?#é';
  mock.method(globalThis, 'fetch', async url => { urls.push(url); return new Response('{}'); });
  await storage.savePage({ ...page, id }, true); await storage.deletePage(id);
  for (const url of urls) assert.equal(new URL(url).pathname, `/api/neuron/${encodeURIComponent(id)}`);
});
