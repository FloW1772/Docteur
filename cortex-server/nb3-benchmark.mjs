// NB-3 — retrieval performance benchmark (synthetic corpora, real SQLite FTS5 +
// real LanceDB, real service.search). Embedding cost is measured separately with
// real Ollama when available; the vectors in the big corpora are random unit
// vectors (768-d, like nomic-embed-text) — latency/memory numbers only, not quality.
// Usage: node nb3-benchmark.mjs   (writes ../reports/nb3-benchmark-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initSqlite, createNotebook, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';

import { upsertChunkVectors } from './src/lib/lancedb.js';
import * as store from './src/lib/notebook-docs-store.js';

const OUT = path.resolve('..', 'reports', 'nb3-benchmark-results.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb3bench-'));
initSqlite(path.join(TMP, 'bench.db'));
store.ensureNotebookDocsSchema();
const LANCE = path.join(TMP, 'bench.lance');
const DIM = 768;
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const ms = (t0) => +(performance.now() - t0).toFixed(1);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const VOCAB = Array.from({ length: 6000 }, (_, i) => { let w = ''; let n = i + 7; for (let k = 0; k < 3 + (i % 5); k++) { w += 'bcdfglmnprstvz'[n % 14] + 'aeiou'[(n >> 3) % 5]; n = Math.floor(n / 3) + 11; } return `${w}${i % 97}`; });
const sentence = () => Array.from({ length: 14 }, () => VOCAB[Math.floor(rnd() ** 1.6 * VOCAB.length)]).join(' ');
const chunkText = () => Array.from({ length: 6 }, sentence).join('. ');
function unitVec() { const v = Array.from({ length: DIM }, () => rnd() - 0.5); const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)); return v.map(x => x / n); }

const report = { generatedAt: new Date().toISOString(), node: process.version, dim: DIM, scales: [] };

async function buildScale(label, docsCount, chunksPerDoc, withVectors) {
  const nb = `bench-${label}`; createNotebook({ id: nb, title: label });
  const db = getDatabase();
  const t0 = performance.now(); const rss0 = rss();
  let vecRows = []; let totalChunks = 0;
  for (let d = 0; d < docsCount; d++) {
    const documentId = store.newDocumentId(); const versionId = store.newVersionId();
    const doc = { documentId, notebookId: nb, nameKey: `d${d}.txt`, title: `d${d}.txt`, mimeType: 'text/plain', size: 1000, status: 'READY', trustLevel: 'UNKNOWN', retention: 'KEEP', origin: 'file' };
    store.insertDocument(doc);
    store.insertVersion({ versionId, documentId, notebookId: nb, versionNo: 1, fileHash: crypto.randomUUID(), size: 1000 });
    const chunks = Array.from({ length: chunksPerDoc }, (_, i) => { const text = chunkText(); return { chunkId: `${documentId}:v1:${i}`, ordinal: i, text, page: null, headingPath: [], startOffset: 0, endOffset: text.length, hash: crypto.createHash('sha256').update(text).digest('hex'), injectionFlags: [] }; });
    store.commitVersion({ doc: { ...doc, notebookId: nb }, version: { versionId, versionNo: 1, fileHash: 'x', size: 1000 }, chunks, trustLevel: 'UNKNOWN', language: null });
    store.recordEmbeddings(chunks.map(c => ({ chunkId: c.chunkId, notebookId: nb, provider: 'ollama', model: 'nomic-embed-text', embedVersion: 'nomic-prefix-v1', dimension: DIM, chunkHash: c.hash })));
    totalChunks += chunks.length;
    if (withVectors) for (const c of chunks) vecRows.push({ chunk_id: c.chunkId, notebook_id: nb, source_id: documentId, version_id: versionId, vector: unitVec() });
    if (vecRows.length >= 2000) { await upsertChunkVectors(LANCE, vecRows); vecRows = []; }
  }
  if (vecRows.length) await upsertChunkVectors(LANCE, vecRows);
  const indexMs = ms(t0);
  return { nb, totalChunks, indexMs, rssDeltaMb: rss() - rss0, ftsRows: db.prepare('SELECT COUNT(*) n FROM nb_chunks_fts WHERE notebook_id = ?').get(nb).n };
}

const queries = () => Array.from({ length: 60 }, () => `${VOCAB[Math.floor(rnd() ** 1.6 * VOCAB.length)]} ${VOCAB[Math.floor(rnd() ** 1.6 * VOCAB.length)]}`);

async function measure(label, docsCount, chunksPerDoc, withVectors) {
  const built = await buildScale(label, docsCount, chunksPerDoc, withVectors);
  const svc = createNotebookDocumentService({
    embedText: async () => unitVec(), embeddingModel: 'nomic-embed-text', lancedbPath: LANCE, localComplete: async () => '', retention: undefined,
  });
  const qs = queries();
  const time = async (fn) => { const t = []; for (const q of qs) { const t0 = performance.now(); await fn(q); t.push(ms(t0)); } return { p50: pct(t, 0.5), p95: pct(t, 0.95), max: Math.max(...t) }; };
  const fts = await time(async (q) => svc.search(built.nb, q, { useVector: false }));
  const dbh = getDatabase();
  const rawFts = await time(async (q) => store.searchFts(built.nb, q, { limit: 24 }));
  const hybrid = withVectors ? await time(async (q) => svc.search(built.nb, q)) : 'NOT_RUN (no vectors at this scale)';
  const { searchChunkVectors } = await import('./src/lib/lancedb.js');
  const vector = withVectors ? await time(async (q) => searchChunkVectors(LANCE, unitVec(), { notebookId: built.nb, limit: 24 })) : 'NOT_RUN';
  const row = { scale: label, documents: docsCount, chunks: built.totalChunks, withVectors, indexSeconds: +(built.indexMs / 1000).toFixed(1), chunksPerSecondIndexed: Math.round(built.totalChunks / (built.indexMs / 1000)), rssDeltaMbWhileIndexing: built.rssDeltaMb, rssMbAfter: rss(), sqliteMb: +(fs.statSync(path.join(TMP, 'bench.db')).size / 1048576).toFixed(1), latencyMs: { ftsSqlOnly: rawFts, ftsService: fts, vectorLanceDB: vector, hybridService: hybrid } };
  report.scales.push(row);
  console.log(JSON.stringify(row));
  void dbh;
}

// real embedding throughput (if Ollama is up)
try {
  const t0 = performance.now(); const N = 30;
  for (let i = 0; i < N; i++) { const r = await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nomic-embed-text', input: `search_document: ${chunkText()}` }) }); if (!r.ok) throw new Error(`${r.status}`); await r.json(); }
  report.realEmbedding = { status: 'MEASURED', chunks: N, msPerChunk: +((performance.now() - t0) / N).toFixed(0), note: 'sequential, ~900-char chunks, local CPU/GPU as configured' };
} catch (e) { report.realEmbedding = { status: 'NOT_RUN', reason: e.message }; }
console.log('embedding', JSON.stringify(report.realEmbedding));

await measure('100 docs', 100, 6, true);       // ~600 chunks
await measure('1,000 docs', 1000, 6, true);    // ~6,000 chunks
await measure('10k chunks', 1000, 10, true);   // 10,000 chunks
await measure('100k chunks (FTS + vectors)', 2000, 50, true); // 100,000 chunks

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
try { getDatabase().close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
console.log('written', OUT);
