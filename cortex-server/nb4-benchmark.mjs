// NB-4 — AI-history import benchmark (synthetic ChatGPT-shaped export, real SQLite FTS5 + real LanceDB +
// real service code; embeddings are deterministic 768-d pseudo-vectors so this measures the pipeline,
// not Ollama). Real embedding throughput is measured separately when Ollama is available.
// Usage: node nb4-benchmark.mjs   (writes ../reports/nb4-benchmark-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, createNotebook, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createAiHistoryService } from './src/lib/notebook-ai-history.js';
import { chatgptConversation, chatgptExport, makeZip } from './nb4-fixtures.mjs';

const OUT = path.resolve('..', 'reports', 'nb4-benchmark-results.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb4bench-'));
initSqlite(path.join(TMP, 'b.db'));
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };

let seed = 424242; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const VOCAB = Array.from({ length: 5000 }, (_, i) => { let w = ''; let n = i + 11; for (let k = 0; k < 3 + (i % 5); k++) { w += 'bcdfglmnprstvz'[n % 14] + 'aeiou'[(n >> 3) % 5]; n = Math.floor(n / 3) + 7; } return `${w}${i % 89}`; });
const sentence = (k = 14) => Array.from({ length: k }, () => VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]).join(' ');
const unit = (text) => { const v = new Array(768).fill(0); let h = 2166136261; for (const ch of text) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; v[h % 768] += 1; } const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map(x => x / n); };

function buildExport(messageCount, perConv = 20) {
  const convs = []; let made = 0; let i = 0;
  while (made < messageCount) {
    const turns = []; const n = Math.min(perConv, messageCount - made);
    for (let t = 0; t < n; t++) turns.push({ role: t % 2 === 0 ? 'user' : 'assistant', text: `${sentence(12)}. ${sentence(10)}${t % 7 === 0 ? '\n\n```js\nconst x = ' + t + ';\nconsole.log(x);\nreturn x;\n```' : ''}` });
    convs.push(chatgptConversation({ id: `b${i}`, title: `Conversation ${i} ${sentence(3)}`, start: 1_700_000_000 + i * 3600, turns })); made += n; i++;
  }
  return chatgptExport(convs);
}

const report = { generatedAt: new Date().toISOString(), node: process.version, note: 'synthetic export; pseudo embeddings (dimension 768); real SQLite + LanceDB', scales: [] };
const lancedbPath = path.join(TMP, 'b.lance');
const doc = createNotebookDocumentService({ embedText: async (t) => unit(t), embeddingModel: 'nomic-embed-text', lancedbPath, localComplete: async () => 'ok', retention: undefined });
const ai = createAiHistoryService(doc, { localComplete: async () => 'ok' });

async function run(label, messages) {
  const nb = `bench-${label}`; createNotebook({ id: nb, title: label });
  const json = buildExport(messages); const zip = makeZip([{ name: 'conversations.json', data: json }]);
  const sizeMb = +(zip.length / 1048576).toFixed(1); const jsonMb = +(json.length / 1048576).toFixed(1);
  global.gc?.(); const rss0 = rssMb(); let peak = rss0; const timer = setInterval(() => { peak = Math.max(peak, rssMb()); }, 100);
  const t0 = performance.now();
  const p0 = performance.now(); const pv = await ai.preview({ notebookId: nb, bytes: zip, filename: `${label}.zip` }); const previewMs = performance.now() - p0;
  const r = await ai.importHistory({ notebookId: nb, bytes: zip, filename: `${label}.zip` });
  const importMs = performance.now() - t0; clearInterval(timer);
  if (r.status !== 'READY') throw new Error(`${label}: ${r.status} ${r.errorCode}`);
  const qs = Array.from({ length: 40 }, () => `${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]} ${VOCAB[Math.floor(rnd() ** 1.5 * VOCAB.length)]}`);
  const time = async (fn) => { const t = []; for (const q of qs) { const s = performance.now(); await fn(q); t.push(performance.now() - s); } return { p50: pct(t, 0.5), p95: pct(t, 0.95) }; };
  const fts = await time((q) => ai.search(nb, q, { useVector: false }));
  const ftsFiltered = await time((q) => ai.search(nb, q, { useVector: false, filters: { providers: ['CHATGPT'], roles: ['USER'], from: '2023-11-14' } }));
  const hybrid = await time((q) => ai.search(nb, q));
  const chunks = getDatabase().prepare('SELECT COUNT(*) n FROM nb_chunks WHERE notebook_id = ?').get(nb).n;
  const row = { scale: label, messages, exportJsonMb: jsonMb, zipMb: sizeMb, conversations: r.counts.conversations, chunks, previewSeconds: +(previewMs / 1000).toFixed(1), importSeconds: +(importMs / 1000).toFixed(1), messagesPerSecond: Math.round(messages / (importMs / 1000)), rssMbBefore: rss0, rssMbPeak: peak, sqliteMb: +(fs.statSync(path.join(TMP, 'b.db')).size / 1048576).toFixed(1), latencyMs: { ftsOnly: fts, ftsFilteredProviderRoleDate: ftsFiltered, hybrid }, previewCounted: pv.counts.messages };
  report.scales.push(row); console.log(JSON.stringify(row));
}

try {
  const t0 = performance.now(); const N = 20;
  for (let i = 0; i < N; i++) { const r = await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nomic-embed-text', input: `search_document: ${sentence(60)}` }) }); if (!r.ok) throw new Error(String(r.status)); await r.json(); }
  report.realEmbedding = { status: 'MEASURED', msPerChunk: +((performance.now() - t0) / N).toFixed(0) };
} catch (e) { report.realEmbedding = { status: 'NOT_RUN', reason: e.message }; }
console.log('embedding', JSON.stringify(report.realEmbedding));

await run('10k messages', 10_000);
await run('100k messages', 100_000);
if (report.realEmbedding.status === 'MEASURED') for (const s of report.scales) s.projectedRealEmbeddingMinutes = +((s.chunks * report.realEmbedding.msPerChunk) / 60000).toFixed(1);
report['1M messages'] = 'NOT_RUN (optional): the pipeline is streaming/batched, but a 1M-message export was not generated here';
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
try { getDatabase().close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
console.log('written', OUT);
