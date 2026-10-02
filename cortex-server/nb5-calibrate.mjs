// NB-5 — REAL embedding calibration of MEMORY retrieval (Ollama + nomic-embed-text).
// Runs the PRODUCTION code path (createMemoryService.retrieve) over a 35-memory / 4-scope corpus (nb5-corpus.mjs)
// with an injected exact-cosine vector store (same maths as LanceDB cosine; parity against REAL LanceDB is
// verified at the end for the chosen configuration). If Ollama / the model is unavailable → NOT_RUN, never simulated.
//
// Measures per configuration: hit@k / MRR on positive queries, false-positive rate on negatives + traps,
// noise (non-expected results per positive query), and hard leakage counters that must be 0 whatever the config:
// wrong project / wrong notebook / revoked / superseded (non-historical) / sensitive (default).
//
// Usage: node nb5-calibrate.mjs   (writes ../reports/nb5-calibration-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, createNotebook } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService, MEMORY_RETRIEVAL_DEFAULTS } from './src/lib/notebook-memory.js';
import { MEMORIES, QUERIES, PROJECTS } from './nb5-corpus.mjs';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = 'nomic-embed-text';
const OUT = path.resolve('..', 'reports', 'nb5-calibration-results.json');
const report = { generatedAt: new Date().toISOString(), model: MODEL, corpus: { memories: MEMORIES.length, queries: QUERIES.length, positives: QUERIES.filter(q => q.expected.length).length, negativesAndTraps: QUERIES.filter(q => !q.expected.length && !q.opts.leakOnly).length, leakOnlyTraps: QUERIES.filter(q => q.opts.leakOnly).length } };

async function ollamaEmbed(text) {
  const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: text }) });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  return (await res.json()).embeddings[0];
}
try { await ollamaEmbed('ping'); } catch (err) {
  report.REAL_EMBEDDING_CALIBRATION = 'NOT_RUN'; report.reason = `Ollama/${MODEL} unavailable: ${err.message}`;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log('REAL_EMBEDDING_CALIBRATION: NOT_RUN —', report.reason); process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5cal-'));
initSqlite(path.join(TMP, 'cal.db'));
const cache = new Map(); let embedCalls = 0;
const cachedEmbed = (t) => { if (!cache.has(t)) { embedCalls++; cache.set(t, ollamaEmbed(t)); } return cache.get(t); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rows = new Map();
const vectorStore = {
  upsert: async (l) => { for (const r of l) rows.set(r.memory_id, r); },
  search: async (v, { scopes, limit }) => [...rows.values()]
    .filter(r => r.scope_kind === 'GLOBAL' || (r.scope_kind === 'PROJECT' && scopes.projectId && r.project_id === scopes.projectId) || (r.scope_kind === 'NOTEBOOK' && scopes.notebookId && r.notebook_id === scopes.notebookId))
    .map(r => ({ memory_id: r.memory_id, scope_kind: r.scope_kind, project_id: r.project_id, notebook_id: r.notebook_id, score: Math.max(0, Math.min(1, dot(v, r.vector))) })).sort((a, b) => b.score - a.score).slice(0, limit),
  delete: async (ids) => { for (const i of ids) rows.delete(i); },
};
createNotebookDocumentService({ embedText: cachedEmbed, embeddingModel: MODEL, vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, lancedbPath: path.join(TMP, 'x.lance'), localComplete: async () => '' }); // creates the schema
const mem = createMemoryService({ embedText: cachedEmbed, embeddingModel: MODEL, vectorStore, localComplete: async () => '' });
for (const id of Object.keys(PROJECTS)) mem.createProject({ projectId: id, name: PROJECTS[id] });
createNotebook({ id: 'nbX', title: 'corpus' }); createNotebook({ id: 'nbY', title: 'other' });

// build the corpus through the real service API (every item is a manual, explicitly created memory)
const ids = {}; let day = 0;
for (const [key, type, scope, statement, state] of MEMORIES) {
  const sc = scope === 'G' ? { kind: 'GLOBAL' } : scope === 'N' ? { kind: 'NOTEBOOK', notebookId: 'nbX' } : { kind: 'PROJECT', projectId: scope.slice(2) };
  const effectiveFrom = new Date(Date.UTC(2026, 0, 1 + (state.startsWith('sup:') ? 0 : 60) + day++)).toISOString();
  const r = await mem.createManual({ type, scope: sc, statement, effectiveFrom, sensitivity: state === 'sens' ? 'SENSITIVE' : state === 'hsens' ? 'HIGHLY_SENSITIVE' : 'NORMAL', confirmGlobal: true, allowDuplicate: true });
  ids[key] = r.memory.memoryId;
}
for (const [key, , , , state] of MEMORIES) {
  if (state.startsWith('sup:')) await mem.confirmSupersession(ids[state.slice(4)], ids[key], { confirm: true });
  if (state === 'rev') await mem.revoke(ids[key], { reason: 'corpus' });
}
const keyOf = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
const meta = Object.fromEntries(MEMORIES.map(m => [m[0], { scope: m[2], state: m[4] }]));
report.corpusState = { active: mem.countMemories('APPROVED'), superseded: mem.countMemories('SUPERSEDED'), revoked: mem.countMemories('REVOKED'), vectors: rows.size };

const ctxOf = (c) => ({ activeProject: c.project ?? null, activeNotebook: c.notebook ? 'nbX' : null });
async function evaluate(cfg, { topK }) {
  let pos = 0; let hit = 0; let mrr = 0; let noise = 0; let neg = 0; let fp = 0; const leaks = { wrongProject: 0, wrongNotebook: 0, revoked: 0, superseded: 0, sensitive: 0 }; const misses = []; const fps = [];
  for (const q of QUERIES) {
    const { leakOnly, ...ro } = q.opts;
    const r = await mem.retrieve(q.query, { ...ctxOf(q.ctx), topK, config: cfg, ...ro });
    const got = r.results.map(x => keyOf[x.memoryId]);
    for (const k of got) {
      const m = meta[k]; const ctx = q.ctx;
      if (m.scope.startsWith('P:') && m.scope.slice(2) !== (ctx.project ?? null)) leaks.wrongProject++;
      if (m.scope === 'N' && !ctx.notebook) leaks.wrongNotebook++;
      if (m.state === 'rev') leaks.revoked++;
      if (m.state.startsWith('sup:') && !q.opts.includeHistorical) leaks.superseded++;
      if (m.state === 'sens' || m.state === 'hsens') leaks.sensitive++;
    }
    if (q.expected.length) {
      pos++; const rank = got.findIndex(k => q.expected.includes(k));
      if (rank >= 0) { hit++; mrr += 1 / (rank + 1); } else misses.push({ q: q.query, got });
      noise += got.filter(k => !q.expected.includes(k)).length;
    } else if (!leakOnly) { neg++; if (got.length) { fp++; fps.push({ q: q.query, got }); } }
  }
  return { hitAtK: +(hit / pos).toFixed(3), mrr: +(mrr / pos).toFixed(3), noisePerPositive: +(noise / pos).toFixed(2), falsePositiveRate: +(fp / neg).toFixed(3), leaks, misses, fps };
}

// ── grid ───────────────────────────────────────────────────────────────────
const grid = []; const t0 = Date.now();
for (const vectorThreshold of [0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) for (const minLexicalCoverage of [0.25, 0.34, 0.5, 0.6]) for (const vectorWeight of [0.5, 1]) for (const topK of [3, 5, 8]) {
  const cfg = { vectorThreshold, minLexicalCoverage, vectorWeight };
  const r = await evaluate(cfg, { topK });
  grid.push({ vectorThreshold, minLexicalCoverage, vectorWeight, topK, ...r });
}
const slim = (g) => ({ ...g, misses: g.misses.length, fps: g.fps.length });
report.gridSize = grid.length; report.gridSeconds = +((Date.now() - t0) / 1000).toFixed(1); report.embedCalls = embedCalls;
report.leakageAcrossAllConfigs = grid.reduce((a, g) => { for (const k of Object.keys(g.leaks)) a[k] = (a[k] ?? 0) + g.leaks[k]; return a; }, {});
// selection: no false positive on traps/negatives first, then hit@k, then MRR, then low noise; ties → defaults, then smaller topK
const score = (g) => [-g.falsePositiveRate, g.hitAtK, g.mrr, -g.noisePerPositive];
const cmp = (a, b) => { const A = score(a); const B = score(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return B[i] - A[i]; return a.topK - b.topK; };
const ranked = [...grid].sort(cmp);
const D = MEMORY_RETRIEVAL_DEFAULTS;
const isDefault = (g) => g.vectorThreshold === D.vectorThreshold && g.minLexicalCoverage === D.minLexicalCoverage && g.vectorWeight === D.vectorWeight && g.topK === D.topK;
report.currentDefaults = slim(grid.find(isDefault));
report.best5 = ranked.slice(0, 5).map(slim);
report.worst3 = ranked.slice(-3).map(slim);
report.defaultsDetail = { misses: grid.find(isDefault).misses, falsePositives: grid.find(isDefault).fps };
const best = ranked[0];
report.recommended = { vectorThreshold: best.vectorThreshold, minLexicalCoverage: best.minLexicalCoverage, vectorWeight: best.vectorWeight, topK: best.topK, ...slim(best) };
report.recommendedDetail = { misses: best.misses, falsePositives: best.fps };
// hit@k for the small top-k choices at the recommended thresholds
report.topKSweep = [3, 5, 8].map(k => { const g = grid.find(x => x.vectorThreshold === best.vectorThreshold && x.minLexicalCoverage === best.minLexicalCoverage && x.vectorWeight === best.vectorWeight && x.topK === k); return { topK: k, hitAtK: g.hitAtK, mrr: g.mrr, noisePerPositive: g.noisePerPositive, falsePositiveRate: g.falsePositiveRate }; });

// ── FTS-only vs hybrid at the recommended thresholds (does the vector channel earn its place?) ──────────
async function evalNoVector(cfg, topK) {
  let pos = 0; let hit = 0; let neg = 0; let fp = 0;
  for (const q of QUERIES) { const { leakOnly, ...ro } = q.opts; const r = await mem.retrieve(q.query, { ...ctxOf(q.ctx), topK, config: cfg, useVector: false, ...ro }); const got = r.results.map(x => keyOf[x.memoryId]); if (q.expected.length) { pos++; if (got.some(k => q.expected.includes(k))) hit++; } else if (!leakOnly) { neg++; if (got.length) fp++; } }
  return { hitAtK: +(hit / pos).toFixed(3), falsePositiveRate: +(fp / neg).toFixed(3) };
}
report.ftsOnly = await evalNoVector({ minLexicalCoverage: best.minLexicalCoverage }, best.topK);

// ── parity with REAL LanceDB at the recommended configuration ─────────────────────────────────────
const lance = createMemoryService({ embedText: cachedEmbed, embeddingModel: MODEL, lancedbPath: path.join(TMP, 'parity.lance'), localComplete: async () => '' });
await lance.reindexMemories(); // real LanceDB table, same statements, same vectors
const same = []; let compared = 0;
for (const q of QUERIES) {
  const { leakOnly, ...ro } = q.opts; void leakOnly;
  const o = { ...ctxOf(q.ctx), topK: best.topK, config: { vectorThreshold: best.vectorThreshold, minLexicalCoverage: best.minLexicalCoverage, vectorWeight: best.vectorWeight }, ...ro };
  const a = (await mem.retrieve(q.query, o)).results.map(x => x.memoryId).join(','); const b = (await lance.retrieve(q.query, o)).results.map(x => x.memoryId).join(',');
  compared++; if (a !== b) same.push({ q: q.query, exact: a.split(',').map(i => keyOf[i]), lancedb: b.split(',').map(i => keyOf[i]) });
}
report.lancedbParity = { compared, identical: compared - same.length, differing: same };
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ corpusState: report.corpusState, leakageAcrossAllConfigs: report.leakageAcrossAllConfigs, currentDefaults: report.currentDefaults, recommended: report.recommended, topKSweep: report.topKSweep, ftsOnly: report.ftsOnly, lancedbParity: { compared, identical: compared - same.length } }, null, 1));
console.log('written', OUT);
process.exit(0);
