// NB-7 — main-chat memory retrieval QUALITY + VALUE OF THE VECTOR CHANNEL, with REAL nomic-embed-text embeddings (Ollama).
// Runs the PRODUCTION chat path (createChatMemory.prepare) over the NB-5 corpus (34 memories / 4 scopes) with chat-shaped queries:
// exact decision, semantic paraphrase, project query, global preference, unrelated, historical, ambiguous project (no project given).
// Compares vectorMode: hybrid (NB-5 default) vs fallback (embed only when FTS found nothing) vs off (FTS only).
// If Ollama / the model is unavailable → NOT_RUN, never simulated.  Usage: node nb7-chat-quality.mjs  (writes ../reports/nb7-chat-quality-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, createNotebook, getNotebook } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { createChatMemory } from './src/lib/chat-memory.js';
import { MEMORIES, QUERIES, PROJECTS } from './nb5-corpus.mjs';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'; const MODEL = 'nomic-embed-text';
const OUT = path.resolve('..', 'reports', 'nb7-chat-quality-results.json');
const report = { generatedAt: new Date().toISOString(), model: MODEL };
async function ollamaEmbed(text) { const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: text }) }); if (!r.ok) throw new Error(`ollama ${r.status}`); return (await r.json()).embeddings[0]; }
try { await ollamaEmbed('ping'); } catch (e) { report.REAL_EMBEDDING_EVALUATION = 'NOT_RUN'; report.reason = e.message; fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log('NOT_RUN —', e.message); process.exit(0); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb7q-')); initSqlite(path.join(TMP, 'q.db'));
const cache = new Map(); const embed = (t) => { if (!cache.has(t)) cache.set(t, ollamaEmbed(t)); return cache.get(t); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rows = new Map();
const vectorStore = { upsert: async l => { for (const r of l) rows.set(r.memory_id, r); }, delete: async ids => { for (const i of ids) rows.delete(i); },
  search: async (v, { scopes, limit }) => [...rows.values()].filter(r => r.scope_kind === 'GLOBAL' || (r.scope_kind === 'PROJECT' && scopes.projectId && r.project_id === scopes.projectId) || (r.scope_kind === 'NOTEBOOK' && scopes.notebookId && r.notebook_id === scopes.notebookId))
    .map(r => ({ memory_id: r.memory_id, scope_kind: r.scope_kind, project_id: r.project_id, notebook_id: r.notebook_id, score: Math.max(0, Math.min(1, dot(v, r.vector))) })).sort((a, b) => b.score - a.score).slice(0, limit) };
createNotebookDocumentService({ embedText: embed, embeddingModel: MODEL, vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, lancedbPath: path.join(TMP, 'x.lance'), localComplete: async () => '' });
const mem = createMemoryService({ embedText: embed, embeddingModel: MODEL, vectorStore, localComplete: async () => '' });
for (const id of Object.keys(PROJECTS)) mem.createProject({ projectId: id, name: PROJECTS[id] });
const NB = 'nbX'; createNotebook({ id: NB, title: 'corpus' });
const ids = {}; let day = 0;
for (const [key, type, scope, statement, state] of MEMORIES) {
  const sc = scope === 'G' ? { kind: 'GLOBAL' } : scope === 'N' ? { kind: 'NOTEBOOK', notebookId: NB } : { kind: 'PROJECT', projectId: scope.slice(2) };
  ids[key] = (await mem.createManual({ type, scope: sc, statement, effectiveFrom: new Date(Date.UTC(2026, 0, 1 + (state.startsWith('sup:') ? 0 : 60) + day++)).toISOString(), sensitivity: state === 'sens' ? 'SENSITIVE' : state === 'hsens' ? 'HIGHLY_SENSITIVE' : 'NORMAL', confirmGlobal: true, allowDuplicate: true })).memory.memoryId;
}
for (const [key, , , , state] of MEMORIES) { if (state.startsWith('sup:')) await mem.confirmSupersession(ids[state.slice(4)], ids[key], { confirm: true }); if (state === 'rev') await mem.revoke(ids[key]); }
const keyOf = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k])); const meta = Object.fromEntries(MEMORIES.map(m => [m[0], { scope: m[2], state: m[4] }]));

const PARAPHRASE = new Set(['Peut-on ajouter des fonctions à OMEGA ?', 'Le Notebook peut-il appeler internet ?', 'Le système peut-il faire des requêtes vers l\'extérieur ?', 'Que faire avant de livrer ?', 'Que faire avant de supprimer des fichiers ?', 'Combien de dimensions font les vecteurs ?']);
const category = (q) => {
  const hist = /avant\s*\?|utilisions|anciennement/i.test(q.query);
  if (hist) return 'historical';
  if (q.expected.length) return PARAPHRASE.has(q.query) ? 'paraphrase' : q.expected.every(k => /^G/.test(k)) ? 'global' : q.expected.every(k => /^n/.test(k)) ? 'notebook' : 'exact_or_project';
  if (!q.ctx.project && !q.ctx.notebook) return 'ambiguous_project';
  return q.opts.leakOnly ? 'notebook_trap' : (/boutique|Device Fabric|panier|blog|notebook/i.test(q.query) ? 'cross_project_trap' : 'unrelated');
};
const modes = { hybrid: { vectorMode: 'hybrid' }, fallback: { vectorMode: 'fallback' }, fts_only: { vectorMode: 'off' } };
report.corpus = { memories: MEMORIES.length, queries: QUERIES.length };
report.modes = {};
for (const [name, cfg] of Object.entries(modes)) {
  const settings = { enabled: true, topK: 3, notebookTopK: 3, maxNotebookChars: 900, ...cfg };
  const chat = createChatMemory({ getMemoryService: () => mem, getNotebook, getSettings: () => settings });
  const byCat = {}; let pos = 0; let hit = 0; let neg = 0; let fp = 0; const leaks = { wrongProject: 0, wrongNotebook: 0, revoked: 0, superseded: 0, sensitive: 0 }; const times = []; const misses = []; const fps = [];
  for (const q of QUERIES) {
    const t0 = performance.now();
    const p = await chat.prepare({ question: q.query, memory_project: q.ctx.project ?? null, memory_notebook: q.ctx.notebook ? NB : null });
    times.push(performance.now() - t0);
    const got = p.memoryUsed.map(u => keyOf[u.memoryId]); const cat = category(q); const c = (byCat[cat] ??= { n: 0, hit: 0, fp: 0 }); c.n++;
    for (const k of got) { const m = meta[k]; if (m.scope.startsWith('P:') && m.scope.slice(2) !== (q.ctx.project ?? null)) leaks.wrongProject++; if (m.scope === 'N' && !q.ctx.notebook) leaks.wrongNotebook++; if (m.state === 'rev') leaks.revoked++; if (m.state.startsWith('sup:') && !p.memory.historical) leaks.superseded++; if (m.state === 'sens' || m.state === 'hsens') leaks.sensitive++; }
    if (q.expected.length) { pos++; if (got.some(k => q.expected.includes(k))) { hit++; c.hit++; } else misses.push({ q: q.query, got }); }
    else if (!q.opts.leakOnly) { neg++; if (got.length) { fp++; c.fp++; fps.push({ q: q.query, got }); } }
  }
  const s = [...times].sort((a, b) => a - b);
  report.modes[name] = { hitAt3: +(hit / pos).toFixed(3), positives: pos, falsePositiveRate: +(fp / neg).toFixed(3), negatives: neg, leaks, byCategory: byCat, missesCount: misses.length, misses, falsePositives: fps, latencyMs: { p50: +s[Math.floor(s.length * 0.5)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1) } };
  console.log(name, JSON.stringify({ hit3: report.modes[name].hitAt3, fp: report.modes[name].falsePositiveRate, leaks, p50: report.modes[name].latencyMs.p50, p95: report.modes[name].latencyMs.p95 }));
}
const H = report.modes.hybrid; const F = report.modes.fallback; const O = report.modes.fts_only;
report.vectorValue = { hybrid: { hitAt3: H.hitAt3, fp: H.falsePositiveRate }, fallback: { hitAt3: F.hitAt3, fp: F.falsePositiveRate }, ftsOnly: { hitAt3: O.hitAt3, fp: O.falsePositiveRate },
  verdict: (H.hitAt3 > O.hitAt3 || F.hitAt3 > O.hitAt3) ? 'VECTOR_ADDS_RECALL' : 'NO_MEASURABLE_GAIN_FROM_VECTOR', embedCallsCached: cache.size };
fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.vectorValue)); console.log('written', OUT); process.exit(0);
