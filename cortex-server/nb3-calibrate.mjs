// NB-3 — REAL embedding calibration (Ollama + nomic-embed-text) of the Notebook
// retrieval stack: vector threshold, lexical coverage gate, RRF constant,
// weights, optional coverage rerank, task prefixes, chunk overlap, LanceDB parity.
//
// Runs the PRODUCTION code path (createNotebookDocumentService → search) with
// an injected in-memory exact-cosine vector store (identical maths to LanceDB
// cosine; parity is verified against real LanceDB at the end).
// If Ollama or the model is unavailable it reports NOT_RUN and never simulates.
//
// Usage: node nb3-calibrate.mjs   (writes ../reports/nb3-calibration-results.json)
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, createNotebook } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { DEFAULT_RETRIEVAL_CONFIG } from './src/lib/notebook-retrieval.js';
import { DOCS, QUERIES } from './nb3-corpus.mjs';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = 'nomic-embed-text';
const OUT = path.resolve('..', 'reports', 'nb3-calibration-results.json');
const enc = (s) => new TextEncoder().encode(s);

async function ollamaEmbed(text) {
  const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: text }) });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  return (await res.json()).embeddings[0];
}

const report = { corpus: { documents: DOCS.length, queries: QUERIES.length, negatives: QUERIES.filter(q => q[2].length === 0).length }, model: MODEL, generatedAt: new Date().toISOString() };
try { await ollamaEmbed('ping'); } catch (err) {
  report.REAL_EMBEDDING_CALIBRATION = 'NOT_RUN';
  report.reason = `Ollama/${MODEL} unavailable: ${err.message}`;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('REAL_EMBEDDING_CALIBRATION: NOT_RUN —', report.reason);
  process.exit(0);
}

const cache = new Map();
let embedCalls = 0;
const cachedEmbed = async (text) => {
  if (!cache.has(text)) { embedCalls++; cache.set(text, ollamaEmbed(text)); }
  return cache.get(text);
};

function memoryVectorStore() {
  const rows = new Map();
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  return {
    upsert: async (list) => { for (const r of list) rows.set(r.chunk_id, r); },
    search: async (v, { notebookId, sourceIds, limit }) => [...rows.values()]
      .filter(r => r.notebook_id === notebookId && (!sourceIds || sourceIds.includes(r.source_id)))
      .map(r => ({ chunk_id: r.chunk_id, notebook_id: r.notebook_id, source_id: r.source_id, version_id: r.version_id, score: Math.max(0, Math.min(1, dot(v, r.vector))) }))
      .sort((a, b) => b.score - a.score).slice(0, limit),
    delete: async (s) => { for (const [k, r] of rows) if (s.chunkIds ? s.chunkIds.includes(k) : (r.notebook_id === s.notebookId && (!s.sourceId || r.source_id === s.sourceId))) rows.delete(k); },
    rows,
  };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb3cal-'));
initSqlite(path.join(TMP, 'cal.db'));

async function buildIndex(nbId, embedFormat, chunkConfig, docs = DOCS) {
  createNotebook({ id: nbId, title: nbId });
  const vectorStore = memoryVectorStore();
  const svc = createNotebookDocumentService({
    embedText: cachedEmbed, embeddingModel: MODEL, embedFormat, vectorStore, chunkConfig,
    localComplete: async () => '', lancedbPath: path.join(TMP, 'unused.lance'), maxConcurrent: 4,
  });
  for (const d of docs) {
    const r = await svc.importDocument({ notebookId: nbId, filename: d.name, bytes: enc(d.text ?? d.bytes) });
    if (r.status !== 'READY') throw new Error(`${d.name}: ${r.status} ${r.errorCode}`);
  }
  return { svc, vectorStore, nbId };
}

const FORMATS = {
  raw: { version: 'raw-v0', docPrefix: '', queryPrefix: '' },
  nomic: { version: 'nomic-prefix-v1', docPrefix: 'search_document: ', queryPrefix: 'search_query: ' },
};

async function evaluate(idx, cfgOverrides, { useVector = true } = {}) {
  const per = [];
  for (const [type, q, relevant] of QUERIES) {
    const found = await idx.svc.search(idx.nbId, q, { config: { ...cfgOverrides, topK: 6 }, useVector });
    const names = []; for (const r of found.results) if (!names.includes(r.sourceTitle)) names.push(r.sourceTitle);
    const rel = new Set(relevant);
    const firstRel = names.findIndex(n => rel.has(n));
    per.push({
      type, q, relevant, names, returned: found.results.length,
      hit1: rel.size ? (names[0] && rel.has(names[0]) ? 1 : 0) : null,
      hit3: rel.size ? (names.slice(0, 3).some(n => rel.has(n)) ? 1 : 0) : null,
      rr: rel.size ? (firstRel >= 0 ? 1 / (firstRel + 1) : 0) : null,
      recall: rel.size ? relevant.filter(r => names.includes(r)).length / rel.size : null,
      precision: rel.size && names.length ? names.filter(n => rel.has(n)).length / names.length : (rel.size ? 0 : null),
      fp: rel.size ? null : (found.results.length > 0 ? 1 : 0),
    });
  }
  const pos = per.filter(p => p.relevant.length); const neg = per.filter(p => !p.relevant.length);
  const mean = (arr, k) => arr.reduce((n, x) => n + x[k], 0) / arr.length;
  const m = { hit1: mean(pos, 'hit1'), hit3: mean(pos, 'hit3'), mrr: mean(pos, 'rr'), recall: mean(pos, 'recall'), precision: mean(pos, 'precision'), fpRate: mean(neg, 'fp') };
  m.J = 0.3 * m.mrr + 0.25 * m.recall + 0.1 * m.precision + 0.35 * (1 - m.fpRate);
  const byType = {};
  for (const t of [...new Set(per.map(p => p.type))]) {
    const g = per.filter(p => p.type === t);
    byType[t] = g[0].relevant.length ? { n: g.length, hit3: +mean(g, 'hit3').toFixed(2), mrr: +mean(g, 'rr').toFixed(2), recall: +mean(g, 'recall').toFixed(2) } : { n: g.length, fpRate: +mean(g, 'fp').toFixed(2) };
  }
  return { m: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(3)])), byType, per };
}

const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
const idx = {};
for (const mode of ['raw', 'nomic']) { idx[mode] = await buildIndex(`cal-${mode}`, FORMATS[mode]); }
console.log(`indexed ${DOCS.length} docs × 2 formats (${embedCalls} embedding calls)`);

// ── 1. Similarity separation ────────────────────────────────────────────────
report.separation = {};
for (const mode of ['raw', 'nomic']) {
  const pos = []; const neg = [];
  for (const [, q, relevant] of QUERIES) {
    const qv = await cachedEmbed(`${FORMATS[mode].queryPrefix}${q}`);
    const hits = await idx[mode].vectorStore.search(qv, { notebookId: idx[mode].nbId, limit: 500 });
    const titles = new Map();
    for (const h of hits) { const doc = h.source_id; titles.set(doc, titles.get(doc) ?? h.score); }
    if (!relevant.length) neg.push(hits[0].score);
    else {
      // best cosine among chunks of relevant docs
      const relIds = new Set(); for (const h of hits) relIds.add(h.source_id);
      pos.push(hits.find(h => relevant.includes(idx[mode].svc.getDocument(idx[mode].nbId, h.source_id)?.title))?.score ?? 0);
    }
  }
  const stat = (a) => ({ min: +Math.min(...a).toFixed(3), p10: +a.sort((x, y) => x - y)[Math.floor(a.length * 0.1)].toFixed(3), median: +a[Math.floor(a.length / 2)].toFixed(3), max: +Math.max(...a).toFixed(3) });
  report.separation[mode] = { relevantBestChunkCosine: stat(pos), negativeQueryTopCosine: stat(neg) };
  console.log(`[separation:${mode}] relevant(best chunk) ${fmt(report.separation[mode].relevantBestChunkCosine)} | negatives(top) ${fmt(report.separation[mode].negativeQueryTopCosine)}`);
}

// ── 2. Baselines: FTS only / vector only / hybrid (production defaults) ─────
report.baselines = {};
for (const mode of ['raw', 'nomic']) {
  const fts = await evaluate(idx[mode], {}, { useVector: false });
  const vec = await evaluate(idx[mode], { minLexicalCoverage: 2 }); // coverage can never reach 2 ⇒ FTS list empty
  const hyb = await evaluate(idx[mode], {});
  report.baselines[mode] = { fts: fts.m, vector: vec.m, hybrid: hyb.m, hybridByType: hyb.byType, ftsByType: fts.byType, vectorByType: vec.byType };
  console.log(`[baseline:${mode}] FTS ${fmt(fts.m)}\n                 VEC ${fmt(vec.m)}\n                 HYB ${fmt(hyb.m)}`);
}

// ── 3. Grid stage 1: vector threshold × lexical coverage (hybrid) ───────────
const T = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
const C = [0, 0.34, 0.5, 0.67, 1];
report.grid1 = {};
for (const mode of ['raw', 'nomic']) {
  const rows = [];
  for (const t of T) for (const c of C) {
    const r = await evaluate(idx[mode], { vectorThreshold: t, minLexicalCoverage: c });
    rows.push({ vectorThreshold: t, minLexicalCoverage: c, ...r.m });
  }
  rows.sort((a, b) => b.J - a.J);
  report.grid1[mode] = { top: rows.slice(0, 8), all: rows };
  console.log(`[grid1:${mode}] top 5:`); rows.slice(0, 5).forEach(r => console.log('   ', fmt(r)));
}
const bestMode = report.grid1.nomic.top[0].J >= report.grid1.raw.top[0].J ? 'nomic' : 'raw';
const best1 = report.grid1[bestMode].top[0];
report.chosenFormat = bestMode;

// ── 3b. Agreement floor: vector hits that are also lexically relevant keep a lower cosine floor ──
const F = [null, 0.4, 0.5, 0.55, 0.6];
const rowsF = [];
for (const f of F) {
  const r = await evaluate(idx[bestMode], { vectorThreshold: best1.vectorThreshold, minLexicalCoverage: best1.minLexicalCoverage, vectorAgreementFloor: f });
  rowsF.push({ vectorAgreementFloor: f, ...r.m });
}
report.gridAgreementFloor = rowsF;
console.log('[agreement floor]'); rowsF.forEach(r => console.log('   ', fmt(r)));

// ── 4. Grid stage 2: RRF constant × weights × coverage rerank ───────────────
const K = [10, 30, 60];
const W = [[1, 1], [1, 0.5], [0.5, 1], [2, 1]];
const R = ['none', 'coverage'];
const rows2 = [];
for (const k of K) for (const [fw, vw] of W) for (const rr of R) {
  const r = await evaluate(idx[bestMode], { vectorThreshold: best1.vectorThreshold, minLexicalCoverage: best1.minLexicalCoverage, rrfK: k, ftsWeight: fw, vectorWeight: vw, rerank: rr });
  rows2.push({ rrfK: k, ftsWeight: fw, vectorWeight: vw, rerank: rr, ...r.m });
}
rows2.sort((a, b) => b.J - a.J);
report.grid2 = { top: rows2.slice(0, 8), all: rows2 };
console.log(`[grid2:${bestMode}] top 5:`); rows2.slice(0, 5).forEach(r => console.log('   ', fmt(r)));
const rrfOnly = rows2.filter(r => r.rerank === 'none').sort((a, b) => b.J - a.J)[0];
const rrfRerank = rows2.filter(r => r.rerank === 'coverage').sort((a, b) => b.J - a.J)[0];
report.rerankVerdict = { rrfOnlyBest: rrfOnly, coverageRerankBest: rrfRerank, benefit: +(rrfRerank.J - rrfOnly.J).toFixed(3) };
console.log('[rerank] RRF only', fmt(rrfOnly), '\n         + coverage rerank', fmt(rrfRerank));

// Robust choice: among configs within 0.01 of the best J, prefer the closest to a plateau centre
// (largest number of neighbouring configs also within 0.02) to avoid overfitting a single point.
const plateau = (rows, keys) => {
  const top = rows[0].J;
  const cand = rows.filter(r => r.J >= top - 0.01);
  const score = (r) => rows.filter(o => keys.every(k => Math.abs(o[k] - r[k]) <= (k === 'vectorThreshold' ? 0.051 : k === 'minLexicalCoverage' ? 0.34 : Infinity)) && o.J >= top - 0.02).length;
  return cand.map(r => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || b.r.J - a.r.J)[0].r;
};
const chosen1 = plateau(report.grid1[bestMode].all.slice().sort((a, b) => b.J - a.J), ['vectorThreshold', 'minLexicalCoverage']);
report.chosen = { format: bestMode, vectorThreshold: chosen1.vectorThreshold, minLexicalCoverage: chosen1.minLexicalCoverage, rrfK: rrfOnly.rrfK, ftsWeight: rrfOnly.ftsWeight, vectorWeight: rrfOnly.vectorWeight, rerank: rrfOnly.rerank };
const chosenEval = await evaluate(idx[bestMode], { vectorThreshold: chosen1.vectorThreshold, minLexicalCoverage: chosen1.minLexicalCoverage, rrfK: rrfOnly.rrfK, ftsWeight: rrfOnly.ftsWeight, vectorWeight: rrfOnly.vectorWeight, rerank: 'none' });
report.chosen.metrics = chosenEval.m; report.chosen.byType = chosenEval.byType;
report.chosen.failures = chosenEval.per.filter(p => (p.relevant.length && p.hit3 === 0) || (!p.relevant.length && p.fp === 1)).map(p => ({ type: p.type, q: p.q, expected: p.relevant, got: p.names }));
console.log('[CHOSEN]', JSON.stringify(report.chosen.metrics), JSON.stringify({ ...report.chosen, metrics: undefined, byType: undefined, failures: undefined }));
console.log('[CHOSEN by type]', JSON.stringify(report.chosen.byType));
console.log('[failures]', JSON.stringify(report.chosen.failures, null, 1));
report.defaultsBefore = { ...DEFAULT_RETRIEVAL_CONFIG };

// ── 5. Chunking: size × overlap on the long document ────────────────────────
// One ~2000-char paragraph per instrument (no paragraph breaks) so chunk boundaries and overlap really matter.
import { FACTS, FILLERS } from './nb3-corpus.mjs';
const longDoc = [{ name: 'long-paragraphs.txt', text: FACTS.map(([name, fact], i) => {
  const pick = (k) => FILLERS[(i + k) % FILLERS.length];
  return `${[0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3].map(pick).join(' ')} The ${name} ${fact}. ${[5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0].map(pick).join(' ')}`;
}).join('\n\n') }];
const factQueries = [
  ['Zenith spectrometer', '45 minute warmup'], ['Borealis centrifuge', '12000 rpm'], ['Quasar oscilloscope', '18 months'], ['Meridian titrator', '30 days'],
  ['Cobalt microscope', '40x objective'], ['Argon incubator', '37 degrees'], ['Helios thermocycler', '95 minutes'], ['Nimbus pipette station', '6 months'],
  ['Vertex balance', '220 gram'], ['Onyx freezer', 'minus 80'], ['Stratus autoclave', '121 degrees'], ['Aurora plate reader', '450 nanometres'],
];
report.chunking = {};
for (const cfg of [{ label: 'overlap 0', OVERLAP_CHARS: 0 }, { label: 'overlap 150 (default)', OVERLAP_CHARS: 150 }, { label: 'overlap 300', OVERLAP_CHARS: 300 }, { label: 'target 500', TARGET_CHARS: 500, MAX_CHARS: 700, MIN_CHARS: 100 }, { label: 'target 1400', TARGET_CHARS: 1400, MAX_CHARS: 1800 }]) {
  const nb = `chunk-${cfg.label.replace(/\W+/g, '')}`;
  const { label, ...cc } = cfg;
  const ix = await buildIndex(nb, FORMATS[bestMode], cc, longDoc);
  const chunks = (await import('./src/lib/sqlite.js')).getDatabase().prepare('SELECT COUNT(*) n, AVG(LENGTH(text)) avg, MAX(LENGTH(text)) mx FROM nb_chunks WHERE notebook_id = ?').get(nb);
  let h1 = 0; let h3 = 0;
  for (const [name, fact] of factQueries) {
    const r = await ix.svc.search(nb, `${name} ${fact.split(' ')[0] === '45' ? 'requirement' : 'specification'}`, { config: { vectorThreshold: chosen1.vectorThreshold, minLexicalCoverage: 0.5, topK: 3 } });
    const idxHit = r.results.findIndex(x => x.text.includes(fact));
    if (idxHit === 0) h1++; if (idxHit >= 0) h3++;
  }
  report.chunking[label] = { chunks: chunks.n, avgChars: Math.round(chunks.avg), maxChars: chunks.mx, factHit1: `${h1}/${factQueries.length}`, factHit3: `${h3}/${factQueries.length}` };
  console.log(`[chunking] ${label}: ${JSON.stringify(report.chunking[label])}`);
}

// ── 6. LanceDB parity for the chosen configuration ──────────────────────────
const { connect } = await import('@lancedb/lancedb');
const { upsertChunkVectors, searchChunkVectors, deleteChunkVectors } = await import('./src/lib/lancedb.js');
const lancePath = path.join(TMP, 'parity.lance');
createNotebook({ id: 'cal-lance', title: 'lance' });
const svcLance = createNotebookDocumentService({
  embedText: cachedEmbed, embeddingModel: MODEL, embedFormat: FORMATS[bestMode], lancedbPath: lancePath, localComplete: async () => '',
  vectorStore: { upsert: (r) => upsertChunkVectors(lancePath, r), search: (v, o) => searchChunkVectors(lancePath, v, o), delete: (s) => deleteChunkVectors(lancePath, s) },
});
for (const d of DOCS) await svcLance.importDocument({ notebookId: 'cal-lance', filename: d.name, bytes: enc(d.text ?? d.bytes) });
const cfgChosen = { vectorThreshold: chosen1.vectorThreshold, minLexicalCoverage: chosen1.minLexicalCoverage, rrfK: rrfOnly.rrfK, ftsWeight: rrfOnly.ftsWeight, vectorWeight: rrfOnly.vectorWeight };
let same = 0;
for (const [, q] of QUERIES) {
  const a = (await idx[bestMode].svc.search(idx[bestMode].nbId, q, { config: cfgChosen })).results.map(r => r.sourceTitle + ':' + r.ordinal).join('|');
  const b = (await svcLance.search('cal-lance', q, { config: cfgChosen })).results.map(r => r.sourceTitle + ':' + r.ordinal).join('|');
  if (a === b) same++; else { (report.lancedbParity ??= { diffs: [] }).diffs.push({ q, memory: a, lance: b }); console.log('   parity diff:', q, '| mem:', a, '| lance:', b); }
}
report.lancedbParity = { ...(report.lancedbParity ?? {}), queries: QUERIES.length, identicalResults: same };
console.log(`[LanceDB parity] ${same}/${QUERIES.length} identical result lists (in-memory exact cosine vs real LanceDB cosine)`);

report.REAL_EMBEDDING_CALIBRATION = 'PASS';
report.embeddingCalls = embedCalls;
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
try { (await import('./src/lib/sqlite.js')).getDatabase().close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir is disposable */ }
console.log('written', OUT);
