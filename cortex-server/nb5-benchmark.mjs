// NB-5 — memory retrieval benchmark (synthetic French statements, real SQLite FTS5 + real LanceDB + real service
// code; embeddings are deterministic 768-d pseudo-vectors so this measures the pipeline, not Ollama).
// Bulk loading is done with direct SQL (a human creates memories one at a time); the INTERACTIVE creation latency
// at each size is measured separately through the real createManual path.
// Usage: node nb5-benchmark.mjs   (writes ../reports/nb5-benchmark-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { upsertMemoryVectors } from './src/lib/lancedb.js';
import { buildMemoryContextPack, buildMemoryMessages } from './src/lib/notebook-memory-context.js';

const OUT = path.resolve('..', 'reports', 'nb5-benchmark-results.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5bench-'));
initSqlite(path.join(TMP, 'b.db'));
const db = getDatabase();
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };
let seed = 20260930; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const VOCAB = Array.from({ length: 4000 }, (_, i) => { let w = ''; let n = i + 13; for (let k = 0; k < 3 + (i % 5); k++) { w += 'bcdfglmnprstvz'[n % 14] + 'aeiou'[(n >> 3) % 5]; n = Math.floor(n / 3) + 7; } return `${w}${i % 97}`; });
const sentence = (k = 14) => Array.from({ length: k }, () => VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]).join(' ');
const unit = (text) => { const v = new Array(768).fill(0); let h = 2166136261; for (const ch of text) { h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0; v[h % 768] += 1; } const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map(x => x / n); };
const embedText = async (t) => unit(String(t).replace(/^search_(document|query): /, ''));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const lancedbPath = path.join(TMP, 'b.lance');
createNotebookDocumentService({ embedText, embeddingModel: 'nomic-embed-text', vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, lancedbPath, localComplete: async () => '' });
const mem = createMemoryService({ embedText, embeddingModel: 'nomic-embed-text', lancedbPath, localComplete: async () => '' });
const PROJECTS = Array.from({ length: 20 }, (_, i) => `proj${i}`); for (const p of PROJECTS) mem.createProject({ projectId: p, name: p });

const report = { generatedAt: new Date().toISOString(), node: process.version, note: 'synthetic statements; pseudo embeddings (768-d); real SQLite FTS5 + real LanceDB; 20 projects', scales: [] };
let loaded = 0;
async function loadTo(n) {
  const ins = db.prepare(`INSERT INTO dmem_items (memory_id, statement, type, status, scope_kind, project_id, notebook_id, confidence, trust_level, sensitivity, created_at, updated_at, approved_at, effective_from, source_kind, approval_source, provenance, injection_flags, version, retention, norm_key, statement_hash)
    VALUES (?,?,?, 'APPROVED', 'PROJECT', ?, '', 1, 'USER_AUTHORED', 'NORMAL', ?, ?, ?, '2026-01-01T00:00:00.000Z', 'MANUAL', 'USER_UI', '{"origin":"USER_AUTHORED_MANUAL"}', '[]', 1, 'KEEP', ?, ?)`);
  const fts = db.prepare('INSERT INTO dmem_items_fts (statement, type, project, memory_id) VALUES (?,?,?,?)');
  const emb = db.prepare("INSERT INTO dmem_embeddings (memory_id, provider, model, dimension, embed_version, statement_hash, created_at) VALUES (?, 'ollama', 'nomic-embed-text', 768, ?, ?, ?)");
  const t = new Date().toISOString();
  while (loaded < n) {
    const batch = []; const end = Math.min(n, loaded + 1000);
    db.transaction(() => { for (; loaded < end; loaded++) {
      const id = `nmem-bench-${loaded}`; const st = `${sentence(10)}. ${sentence(6)}`; const proj = PROJECTS[loaded % PROJECTS.length]; const h = sha(st);
      ins.run(id, st, 'PROJECT_FACT', proj, t, t, t, h.slice(0, 24), h); fts.run(st, 'PROJECT FACT', `${proj} PROJECT`, id); emb.run(id, mem.embedFormat.version, h, t);
      batch.push({ memory_id: id, scope_kind: 'PROJECT', project_id: proj, notebook_id: '', vector: unit(st) });
    } })();
    await upsertMemoryVectors(lancedbPath, batch);
  }
}
const N_Q = 60;
async function run(n) {
  const l0 = performance.now(); await loadTo(n); const loadSec = +((performance.now() - l0) / 1000).toFixed(1);
  const qs = Array.from({ length: N_Q }, () => `${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]} ${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]} ${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]}`);
  const time = async (fn) => { const t = []; for (const q of qs) { const s = performance.now(); await fn(q); t.push(performance.now() - s); } return { p50: pct(t, 0.5), p95: pct(t, 0.95) }; };
  const ctx = (i) => ({ activeProject: PROJECTS[i % PROJECTS.length] });
  let i = 0; const fts = await time((q) => mem.retrieve(q, { ...ctx(i++), useVector: false }));
  i = 0; const hybrid = await time((q) => mem.retrieve(q, { ...ctx(i++) }));
  // a hybrid query that actually retrieves something: reuse a stored statement's words
  const sample = db.prepare('SELECT statement, project_id FROM dmem_items WHERE memory_id = ?').get(`nmem-bench-${Math.floor(n / 2)}`);
  const hits = []; for (let k = 0; k < 20; k++) { const s = performance.now(); const r = await mem.retrieve(sample.statement.split(' ').slice(0, 6).join(' '), { activeProject: sample.project_id }); hits.push(performance.now() - s); if (k === 0) report.lastHitCount = r.results.length; }
  // context pack build + render
  const r = await mem.retrieve(sample.statement.split(' ').slice(0, 6).join(' '), { activeProject: sample.project_id, topK: 8 });
  const pk = []; for (let k = 0; k < 200; k++) { const s = performance.now(); const p = buildMemoryContextPack({ requestId: 'x', memories: r.results }); buildMemoryMessages(p, 'question'); pk.push(performance.now() - s); }
  // interactive creation (real path: duplicate check + conflict + supersession scan + embed + vector upsert)
  const cr = []; for (let k = 0; k < 15; k++) { const s = performance.now(); await mem.createManual({ type: 'PROJECT_FACT', scope: { kind: 'PROJECT', projectId: PROJECTS[k % PROJECTS.length] }, statement: `${sentence(9)} création ${n}-${k}` }); cr.push(performance.now() - s); }
  const rss = rssMb();
  const row = { memories: n, loadSeconds: loadSec, latencyMs: { ftsOnly: fts, hybrid, hybridWithHits: { p50: pct(hits, 0.5), p95: pct(hits, 0.95) }, contextPackBuildRender: { p50: pct(pk, 0.5), p95: pct(pk, 0.95) }, interactiveCreate: { p50: pct(cr, 0.5), p95: pct(cr, 0.95) } }, sqliteMb: +(fs.statSync(path.join(TMP, 'b.db')).size / 1048576).toFixed(1), rssMb: rss };
  report.scales.push(row); console.log(JSON.stringify(row));
}
await run(1000);
await run(10000);
report['100k memories'] = 'NOT_RUN (optional): a personal memory of this size is unrealistic for human-approved items; the SQL/FTS/LanceDB paths are index- and pushdown-based, but 100k was not generated here';
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
try { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
console.log('written', OUT);
process.exit(0);
