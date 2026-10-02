// Notebook NB-3 — heuristic detection of contradictory sources.
//
// Deterministic, local, no LLM. It reports POSSIBLE conflicts between
// retrieved chunks so the answer never silently merges them:
//   - POLARITY : same topic, opposite polarity (active/désactivée, enabled/disabled,
//                or negation on one side only)
//   - NUMERIC  : same topic, different numbers (10 Mbit/s vs 100 Mbit/s)
//   - VERSION  : same document, different versions of a sentence (historical mixing)
// A conflict is an alert with both citations; the model is instructed to present
// both positions, not to decide. False positives are possible and labelled.

import { normalizeToken, STOPWORDS } from './notebook-docs-store.js';

const POSITIVE = new Set(['actif', 'active', 'activee', 'actives', 'enabled', 'autorise', 'autorisee', 'allowed', 'supported', 'supporte', 'supportee', 'supportes', 'supportees', 'available', 'disponible', 'vrai', 'true', 'oui', 'yes', 'valide', 'valid', 'ouvert', 'open', 'obligatoire', 'required', 'enabled']);
const NEGATIVE = new Set(['inactif', 'inactive', 'desactive', 'desactivee', 'desactives', 'disabled', 'interdit', 'interdite', 'forbidden', 'prohibited', 'unsupported', 'unavailable', 'non-supporte', 'indisponible', 'faux', 'false', 'non', 'invalide', 'invalid', 'ferme', 'closed', 'optionnel', 'optional', 'deprecated', 'obsolete', 'abandonne']);
const NEGATION_CUES = new Set(['pas', 'jamais', 'aucun', 'aucune', 'not', 'never', 'cannot', 'nt', 'nullement', 'sans', 'without']);

const sentences = (text) => String(text ?? '').split(/(?<=[.!?;\n])\s+/).map(s => s.trim()).filter(s => s.length >= 8);

function analyse(sentence) {
  const norm = normalizeToken(sentence.replace(/n['’]t\b/gi, ' nt'));
  const words = norm.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const numbers = new Set();
  for (const m of norm.matchAll(/\d+(?:[.,]\d+)?/g)) numbers.add(m[0].replace(',', '.'));
  const topic = new Set();
  let pos = 0; let neg = 0; let negation = 0;
  for (const w of words) {
    if (POSITIVE.has(w)) pos++;
    else if (NEGATIVE.has(w)) neg++;
    else if (NEGATION_CUES.has(w)) negation++;
    else if (!STOPWORDS.has(w) && w.length > 1 && !/^\d/.test(w)) topic.add(w);
  }
  const polarity = (pos > 0 ? 1 : 0) - (neg > 0 ? 1 : 0);
  return { topic, numbers, polarity, negated: negation % 2 === 1 };
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

const excerpt = (s) => (s.length > 220 ? `${s.slice(0, 217)}…` : s);

function compareSentences(sa, sb, minTopic) {
  const A = analyse(sa); const B = analyse(sb);
  const overlap = jaccard(A.topic, B.topic);
  if (overlap < minTopic) return null;
  // identical statements are not conflicts
  if (normalizeToken(sa) === normalizeToken(sb)) return null;
  const effA = A.polarity !== 0 ? A.polarity * (A.negated ? -1 : 1) : (A.negated ? -1 : 0);
  const effB = B.polarity !== 0 ? B.polarity * (B.negated ? -1 : 1) : (B.negated ? -1 : 0);
  if (effA !== 0 && effB !== 0 && effA !== effB) return { type: 'POLARITY', overlap, evidence: { a: effA > 0 ? 'affirmatif' : 'négatif', b: effB > 0 ? 'affirmatif' : 'négatif' } };
  if (effA === 0 && effB === 0 && A.negated !== B.negated) return { type: 'POLARITY', overlap, evidence: { negation: 'une seule des deux phrases est négative' } };
  if (A.numbers.size && B.numbers.size && overlap >= Math.max(minTopic, 0.5)) {
    const onlyA = [...A.numbers].filter(n => !B.numbers.has(n));
    const onlyB = [...B.numbers].filter(n => !A.numbers.has(n));
    if (onlyA.length && onlyB.length) return { type: 'NUMERIC', overlap, evidence: { a: onlyA, b: onlyB } };
  }
  return null;
}

const describe = (c, snippet) => ({
  citationId: c.citationId ?? null, chunkId: c.chunkId, sourceId: c.sourceId, sourceTitle: c.sourceTitle ?? '',
  documentVersion: c.documentVersion, importedAt: c.importedAt ?? null, page: c.page ?? null,
  startOffset: c.startOffset ?? null, endOffset: c.endOffset ?? null, isCurrent: c.isCurrent !== false, excerpt: excerpt(snippet),
});

export function detectConflicts(chunks, { minTopicOverlap = 0.4, max = 10 } = {}) {
  const conflicts = [];
  for (let i = 0; i < chunks.length && conflicts.length < max; i++) {
    for (let j = i + 1; j < chunks.length && conflicts.length < max; j++) {
      const a = chunks[i]; const b = chunks[j];
      if (a.chunkId === b.chunkId) continue;
      const sameDoc = a.documentId === b.documentId;
      if (sameDoc && a.documentVersion === b.documentVersion) continue; // same statement source
      let best = null;
      for (const sa of sentences(a.text)) {
        for (const sb of sentences(b.text)) {
          const r = compareSentences(sa, sb, minTopicOverlap);
          if (r && (!best || r.overlap > best.r.overlap)) best = { r, sa, sb };
        }
      }
      if (best) {
        conflicts.push({
          type: sameDoc ? 'VERSION' : best.r.type,
          detail: best.r.type,
          heuristic: true,
          topicOverlap: Number(best.r.overlap.toFixed(2)),
          evidence: best.r.evidence,
          a: describe(a, best.sa),
          b: describe(b, best.sb),
        });
      }
    }
  }
  return conflicts;
}
