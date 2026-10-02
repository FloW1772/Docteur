// NB-7 — main-chat memory retrieval benchmark (chat-memory.prepare) (synthetic French statements, real SQLite FTS5 + real LanceDB + real service
// code; embeddings are deterministic 768-d pseudo-vectors so this measures the pipeline, not Ollama).
// Bulk loading is done with direct SQL (a human creates memories one at a time); the INTERACTIVE creation latency
// at each size is measured separately through the real createManual path.
// Usage: node nb7-benchmark.mjs   (writes ../reports/nb7-benchmark-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { createChatMemory } from './src/lib/chat-memory.js';
import { getNotebook } from './src/lib/sqlite.js';
import { upsertMemoryVectors } from './src/lib/lancedb.js';
import { buildMemoryContextPack, buildMemoryMessages } from './src/lib/notebook-memory-context.js';

const OUT = path.resolve('..', 'reports', 'nb7-benchmark-results.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb7bench-'));
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
const settingsFor = (vectorMode, enabled = true) => ({ enabled, topK: 3, notebookTopK: 3, maxNotebookChars: 900, vectorMode });
const chatFor = (st) => createChatMemory({ getMemoryService: () => mem, getNotebook, getSettings: () => st });
async function run(n) {
  const l0 = performance.now(); await loadTo(n); const loadSec = +((performance.now() - l0) / 1000).toFixed(1);
  const qs = Array.from({ length: N_Q }, () => `${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]} ${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]} ${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]}`);
  const sample = db.prepare('SELECT statement, project_id FROM dmem_items WHERE memory_id = ?').get(`nmem-bench-${Math.floor(n / 2)}`); const hitQ = sample.statement.split(' ').slice(0, 6).join(' ');
  const time = async (chat, queries, ctxFn, extra = {}) => { const t = []; for (let i = 0; i < queries.length; i++) { const s0 = performance.now(); await chat.prepare({ question: queries[i], memory_project: ctxFn(i), ...extra }); t.push(performance.now() - s0); } return { p50: pct(t, 0.5), p95: pct(t, 0.95) }; };
  const proj = (i) => PROJECTS[i % PROJECTS.length]; const row = { memories: n, loadSeconds: loadSec, latencyMs: {} };
  row.latencyMs.toggleOff = await time(chatFor(settingsFor('off')), qs, proj, { use_memory: false });
  row.latencyMs.noLexicalMatch_ftsOnly = await time(chatFor(settingsFor('off')), qs, proj);
  row.latencyMs.noLexicalMatch_vectorFallback = await time(chatFor(settingsFor('fallback')), qs, proj);
  row.latencyMs.noLexicalMatch_hybrid = await time(chatFor(settingsFor('hybrid')), qs, proj);
  const hitQs = Array.from({ length: 30 }, () => hitQ);
  row.latencyMs.withHit_ftsOnly = await time(chatFor(settingsFor('off')), hitQs, () => sample.project_id);
  row.latencyMs.withHit_hybrid = await time(chatFor(settingsFor('hybrid')), hitQs, () => sample.project_id);
  const one = await chatFor(settingsFor('off')).prepare({ question: hitQ, memory_project: sample.project_id }); row.hitInjected = one.memoryUsed.length; row.packBytes = one.systemMessages.reduce((a, m) => a + m.content.length, 0);
  row.sqliteMb = +(fs.statSync(path.join(TMP, 'b.db')).size / 1048576).toFixed(1); row.rssMb = rssMb();
  report.scales.push(row); console.log(JSON.stringify(row));
}
await run(1000);
await run(10000);
report['100k memories'] = 'NOT_RUN (optional): human-approved memory of that size is unrealistic; the paths are index / pushdown based but 100k was not generated here';
report.note2 = 'Ollama embedding of the query is NOT included for vector modes (pseudo embeddings): add ~20-60 ms per vector call on a warm nomic-embed-text; FTS-only (the chat default) makes no Ollama call for memory.';
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
try { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
console.log('written', OUT);
process.exit(0);
