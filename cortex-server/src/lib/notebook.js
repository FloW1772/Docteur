// Local Notebook — documentary/RAG workspace (Phase 5, MASTER mission).
//
// A Notebook groups references to EXISTING content (neurons, connector
// syncs, manually-added text saved as a neuron) — it never duplicates
// embeddings. RAG retrieval is scoped to ONLY the notebook's own sources
// (lancedb.js searchNeuronsByIds, LanceDB .where() id-list pushdown) —
// never the whole neuron store, and the whole notebook content is never
// sent to the LLM in one shot: only the top-k retrieved chunks + context
// budget (mirrors lib/memory.js's budget philosophy from Phase 3).
//
// Citations are STRUCTURED (source id, title, passage) and always trace
// back to a chunk that was actually retrieved — never invented.
//
// Privacy: a Notebook's privacy/egress_policy is DERIVED from its sources
// (most restrictive wins) and recomputed on every source add/remove —
// never settable directly by a client.

import crypto from 'node:crypto';
import { chunkText } from './chunking.js';
import {
  getNotebook, listNotebookSources, setNotebookPrivacy,
  getNotebookSummary, setNotebookSummary,
} from './sqlite.js';

const DEFAULT_TOP_K = 6;
const MAX_CONTEXT_CHARS_PER_CHUNK = 1200;
const CHUNK_MAX_CHARS = 1200; // smaller than corpus.js's 3500 — notebook chunks favor precise citations over fewer, larger blocks
const SUMMARY_SOURCE_CHAR_BUDGET = 20_000; // hard cap on how much raw source text feeds a level-1 summary prompt

// ── Privacy aggregation — most restrictive of all sources wins ─────────────
// Mirrors the boolean-OR pattern already used in server.js
// (hasPrivateSources = sources.some(...)) — generalized to a notebook's
// source collection. A notebook can never be less restrictive than any of
// its sources; adding one local_only source flips the whole notebook.
export function computeNotebookPrivacy(sources) {
  const anyPrivate = sources.some(s => s.privacy === true || s.egress_policy === 'local_only');
  return { privacy: anyPrivate, egressPolicy: anyPrivate ? 'local_only' : 'cloud_allowed' };
}

export function recomputeAndPersistNotebookPrivacy(notebookId) {
  const sources = listNotebookSources(notebookId, { limit: 10_000 });
  const { privacy, egressPolicy } = computeNotebookPrivacy(sources);
  setNotebookPrivacy(notebookId, { privacy, egressPolicy });
  return { privacy, egressPolicy };
}

// ── Chunking for retrieval ──────────────────────────────────────────────────
// A notebook source's neuron content is chunked at read time (not stored
// separately) — the neuron itself remains the single source of truth, and
// re-chunking is cheap (pure string splitting, no embedding cost) compared
// to maintaining a second copy that could drift from the neuron.
export function chunkSourceContent(source) {
  const chunks = chunkText(source.content ?? '', CHUNK_MAX_CHARS);
  return chunks.map((text, index) => ({
    chunkId: `${source.id}#${index}`,
    sourceId: source.id,
    sourceTitle: source.title,
    index,
    text,
  }));
}

// ── RAG retrieval scoped to a notebook's sources ────────────────────────────
// deps: { embedText, searchNeuronsByIds } — injected so this module has no
// direct Ollama/LanceDB-path coupling (same pattern as lib/memory.js's
// extractWithOllama receiving a caller-provided local completion fn).
export async function retrieveForQuestion(deps, notebookId, question, { topK = DEFAULT_TOP_K } = {}) {
  const sources = listNotebookSources(notebookId, { limit: 10_000 });
  if (sources.length === 0) return { chunks: [], sourceIds: [] };

  const sourceNeuronIds = sources.map(s => s.source_id);
  const vector = await deps.embedText(question);
  // Cast a slightly wider net than topK at the LanceDB layer since a single
  // neuron may contribute multiple chunks after chunkSourceContent() below —
  // over-fetching here is still scoped to ONLY this notebook's ids (LanceDB
  // .where() pushdown), never the whole neuron store, so it stays cheap even
  // for a notebook with hundreds of sources.
  const candidateNeurons = await deps.searchNeuronsByIds(vector, sourceNeuronIds, { limit: Math.max(topK * 2, sourceNeuronIds.length) });

  const sourceById = new Map(sources.map(s => [s.source_id, s]));
  const allChunks = [];
  for (const neuron of candidateNeurons) {
    const notebookSource = sourceById.get(neuron.id);
    if (!notebookSource) continue;
    const chunks = chunkSourceContent({ id: neuron.id, title: neuron.title || notebookSource.title, content: neuron.content });
    for (const chunk of chunks) allChunks.push({ ...chunk, neuronScore: neuron.score, provenance: notebookSource.provenance, sourceType: notebookSource.source_type });
  }

  // Rank chunks by their parent neuron's vector score (chunk-level scoring
  // would need per-chunk embeddings — out of scope for this phase; see
  // MASTER_PHASE_5 report limitations) and take the top-k chunks overall.
  const topChunks = allChunks
    .sort((a, b) => b.neuronScore - a.neuronScore)
    .slice(0, topK)
    .map(c => ({ ...c, text: c.text.length > MAX_CONTEXT_CHARS_PER_CHUNK ? `${c.text.slice(0, MAX_CONTEXT_CHARS_PER_CHUNK)}…` : c.text }));

  return { chunks: topChunks, sourceIds: [...new Set(topChunks.map(c => c.sourceId))] };
}

// ── Prompt + structured citations ───────────────────────────────────────────
// Every citation in the response is guaranteed to correspond to a chunk that
// was actually retrieved (chunkId comes straight from retrieveForQuestion) —
// never an invented reference. The model is instructed to cite by [N] index;
// we map [N] back to the concrete chunk after the fact.
export function buildNotebookMessages(question, chunks) {
  const context = chunks
    .map((c, i) => `[${i + 1}] Source: "${c.sourceTitle}"\n${c.text}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: 'Tu réponds uniquement à partir des extraits fournis, qui proviennent des sources de ce Notebook. Cite chaque affirmation importante avec son numéro de référence entre crochets, par exemple [1]. Si l\'information n\'est pas dans les extraits, dis-le clairement — n\'invente jamais une source ni un numéro de référence qui n\'existe pas dans la liste fournie.',
    },
    { role: 'system', content: `Extraits disponibles :\n\n${context}` },
    { role: 'user', content: question },
  ];
}

// Extracts the [N] markers actually used in the answer text and maps them
// to their real chunk — citations never include an index the model didn't
// actually reference, and never fabricate one outside the provided range.
export function extractCitations(answerText, chunks) {
  const used = new Set();
  const re = /\[(\d+)\]/g;
  let match;
  while ((match = re.exec(answerText)) !== null) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < chunks.length) used.add(index);
  }
  return [...used].sort((a, b) => a - b).map(i => ({
    ref: i + 1,
    chunkId: chunks[i].chunkId,
    sourceId: chunks[i].sourceId,
    sourceTitle: chunks[i].sourceTitle,
    passage: chunks[i].text.slice(0, 300),
  }));
}

// ── Hierarchical summary (level 1 global only in this phase — see report) ──
// Cached in notebook_summaries, invalidated whenever the source set changes
// (invalidateNotebookSummaries, called by sqlite.js's
// addNotebookSource/removeNotebookSource/touchNotebookSource). Recomputed
// lazily on next request, never eagerly on every edit.
function sourcesHash(sources) {
  const key = sources.map(s => s.source_id).sort().join(',');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export async function getOrBuildGlobalSummary(deps, notebookId) {
  const sources = listNotebookSources(notebookId, { limit: 10_000 });
  if (sources.length === 0) return { content: '', cached: false, sourceCount: 0 };

  const hash = sourcesHash(sources);
  const cached = getNotebookSummary(notebookId, 1, '');
  if (cached && cached.sources_hash === hash) return { content: cached.content, cached: true, sourceCount: sources.length };

  const neuronIds = sources.map(s => s.source_id);
  const neurons = await deps.getNeuronsByIds(neuronIds);
  let combined = neurons.map(n => `## ${n.title}\n${n.content}`).join('\n\n');
  if (combined.length > SUMMARY_SOURCE_CHAR_BUDGET) combined = `${combined.slice(0, SUMMARY_SOURCE_CHAR_BUDGET)}…`;

  const messages = [
    { role: 'system', content: 'Résume en français, de façon structurée (Markdown), l\'ensemble des sources suivantes. Sois concis mais complet — un résumé global de ce Notebook, pas une liste exhaustive de détails.' },
    { role: 'user', content: combined || '(aucune source disponible)' },
  ];
  const content = await deps.localComplete(messages);
  setNotebookSummary(notebookId, 1, '', content, hash);
  return { content, cached: false, sourceCount: sources.length };
}

export function notebookOverview(notebookId) {
  const notebook = getNotebook(notebookId);
  if (!notebook) return null;
  const sources = listNotebookSources(notebookId, { limit: 10_000 });
  return { notebook, sourceCount: sources.length };
}
