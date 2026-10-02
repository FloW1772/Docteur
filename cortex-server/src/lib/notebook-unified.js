// Notebook NB-4 — EXPLICIT unified retrieval across the three source kinds of a Notebook:
//   neurons (legacy Phase-5 references) · documents (NB-2/3 chunks) · ai_history (NB-4 messages).
//
// It is a NEW opt-in surface (POST …/unified-search, …/unified-ask). The legacy endpoints
// (/ask, /summary, NotebookLM export) are untouched and keep their exact historical behaviour.
// Every citation is typed — NEURON | DOCUMENT_CHUNK | AI_HISTORY_MESSAGE — and namespaced, so an
// id can never be ambiguous. Scores of the three retrievers are not comparable (cosine vs RRF),
// so the merge is a deterministic round-robin over each retriever's own ranking.

import { buildCitationPack, buildDocumentMessages, AI_HISTORY_SYSTEM_PROMPT, NOTEBOOK_SYSTEM_PROMPT, assertionTypeFor } from './notebook-security.js';
import { detectConflicts } from './notebook-conflicts.js';
import { NotebookImportError } from './notebook-parsers.js';

export const UNIFIED_SCOPES = Object.freeze(['neurons', 'documents', 'ai_history', 'all']);

export function createUnifiedService({ docService, aiService, neuronSearch, localComplete }) {
  const scopesOf = (scope) => {
    if (!UNIFIED_SCOPES.includes(scope)) throw new NotebookImportError('INVALID_OPTION', `scope invalide : ${scope} (${UNIFIED_SCOPES.join(', ')})`);
    return scope === 'all' ? ['neurons', 'documents', 'ai_history'] : [scope];
  };

  async function search(notebookId, query, { scope = 'all', topK = 6, filters = {} } = {}) {
    const scopes = scopesOf(scope);
    const lists = {}; let retrievalMode = 'HYBRID'; let vectorStatus = 'READY';
    if (scopes.includes('neurons') && neuronSearch) {
      const ns = await neuronSearch(notebookId, query, topK);
      lists.neurons = ns.map(c => ({ type: 'NEURON', chunkId: `neuron:${c.chunkId}`, sourceId: c.sourceId, sourceTitle: c.sourceTitle, text: c.text, trustLevel: 'UNKNOWN', documentVersion: 1, versionId: 'neuron', hash: c.chunkId, page: null, headingPath: [], injectionFlags: detectInj(c.text) }));
    }
    if (scopes.includes('documents')) {
      const d = await docService.search(notebookId, query, { topK });
      retrievalMode = d.retrievalMode; vectorStatus = d.vectorStatus;
      lists.documents = d.results.map(r => ({ ...r, type: 'DOCUMENT_CHUNK' }));
    }
    if (scopes.includes('ai_history')) {
      const a = await aiService.search(notebookId, query, { topK, filters });
      retrievalMode = a.retrievalMode; vectorStatus = a.vectorStatus;
      lists.ai_history = a.results;
    }
    const order = ['neurons', 'documents', 'ai_history'].filter(k => lists[k]);
    const merged = []; const idx = Object.fromEntries(order.map(k => [k, 0]));
    while (merged.length < topK && order.some(k => idx[k] < lists[k].length)) for (const k of order) { if (merged.length >= topK) break; if (idx[k] < lists[k].length) merged.push(lists[k][idx[k]++]); }
    return { scope, retrievalMode, vectorStatus, results: merged, perScope: Object.fromEntries(order.map(k => [k, lists[k].length])) };
  }

  const detectInj = (t) => (/ignore\s+(all\s+)?previous|run\s+(shell|powershell)|system\s*:/i.test(t) ? ['POSSIBLE_INSTRUCTION_TEXT'] : []);

  async function ask(notebookId, question, opts = {}) {
    const found = await search(notebookId, question, opts);
    if (!found.results.length) return { status: 'NO_RELEVANT_SOURCE', scope: found.scope, answer: 'Aucune source pertinente pour cette question dans ce périmètre.', citations: [], uncertainties: [{ code: 'NO_RELEVANT_SOURCE', message: 'Le LLM n\'a pas été appelé.' }], sourceConflicts: [], perScope: found.perScope, retrievalMode: found.retrievalMode };
    const hasAi = found.results.some(r => r.type === 'AI_HISTORY_MESSAGE');
    const pack = buildCitationPack(question, found.results.map(r => ({
      ...r, sourceId: r.sourceId ?? r.documentId, documentVersion: r.documentVersion ?? 1, versionId: r.versionId ?? r.importId ?? 'x',
      speaker: r.type === 'AI_HISTORY_MESSAGE' ? r.speaker : undefined, date: r.type === 'AI_HISTORY_MESSAGE' ? r.date : undefined,
    })));
    const conflicts = detectConflicts(pack.chunks.map((c, i) => ({ ...c, documentId: found.results[i].conversationId ? `${found.results[i].conversationId}|${found.results[i].role}` : (found.results[i].documentId ?? found.results[i].sourceId) })));
    const { messages } = buildDocumentMessages(pack, { conflicts, systemPrompt: hasAi ? AI_HISTORY_SYSTEM_PROMPT : NOTEBOOK_SYSTEM_PROMPT });
    const answer = String(await localComplete(messages) ?? '');
    const used = new Set(); const re = /\[(\d+)\]/g; let m;
    while ((m = re.exec(answer)) !== null) { const i = Number(m[1]) - 1; if (i >= 0 && i < found.results.length) used.add(i); }
    const citations = [];
    for (const i of [...used].sort((a, b) => a - b)) {
      const r = found.results[i];
      let valid = true;
      if (r.type === 'DOCUMENT_CHUNK') valid = docService.verifyCitation(notebookId, { chunkId: r.chunkId, versionId: r.versionId, hash: r.hash }).valid;
      else if (r.type === 'AI_HISTORY_MESSAGE') valid = aiService.verifyCitation(notebookId, { chunkId: r.chunkId, hash: r.hash }).valid;
      if (!valid) continue;
      citations.push({
        type: r.type, ref: i + 1, chunkId: r.chunkId, sourceId: r.sourceId, sourceTitle: r.sourceTitle, trustLevel: r.trustLevel, assertionType: r.type === 'NEURON' ? 'SOURCE_FACT' : assertionTypeFor(r.trustLevel),
        ...(r.type === 'DOCUMENT_CHUNK' ? { documentVersion: r.documentVersion, page: r.page, headingPath: r.headingPath } : {}),
        ...(r.type === 'AI_HISTORY_MESSAGE' ? { importId: r.importId, conversationId: r.conversationId, conversationTitle: r.conversationTitle, provider: r.provider, role: r.role, messageIds: r.messageIds, date: r.date, speaker: r.speaker } : {}),
        passage: r.text.slice(0, 300),
      });
    }
    const uncertainties = [];
    if (!citations.length) uncertainties.push({ code: 'NO_CITATION_IN_ANSWER', message: 'La réponse ne cite aucune source : inférence non vérifiée.' });
    if (found.results.some(r => r.type === 'AI_HISTORY_MESSAGE' && r.assertionType === 'PAST_AI_ASSERTION')) uncertainties.push({ code: 'PAST_AI_SOURCE_USED', message: 'Au moins une source est une ancienne réponse d\'IA (non vérifiée).' });
    if (conflicts.length) uncertainties.push({ code: 'SOURCE_CONFLICT', message: `${conflicts.length} conflit(s) possible(s) entre sources.` });
    return { status: 'ANSWERED', scope: found.scope, answer, citations, uncertainties, sourceConflicts: conflicts, perScope: found.perScope, retrievalMode: found.retrievalMode, vectorStatus: found.vectorStatus };
  }

  return { search, ask };
}
