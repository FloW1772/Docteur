// KG-5 synthetic retrieval world (test fixture / benchmark, temporary databases only).
//
// A small French corpus imported into a Notebook through its PUBLIC service
// (Notebook is frozen and only used), the same documents ingested into the KG
// with claims whose evidence cites the Notebook chunks, and a hand-labelled
// ground truth. The ground truth is SYNTHETIC and deliberately covers the cases
// where a graph should help (aliases absent from the text, relations, time,
// contradictions) as well as plain lexical questions where it should not hurt.

import crypto from 'node:crypto';
import { createNotebook, setNotebookPrivacy, getNotebook } from '../src/lib/sqlite.js';
import { createNotebookDocumentService } from '../src/lib/notebook-documents.js';
import { getDocument, getCurrentChunkRows, getChunkAnyVersion } from '../src/lib/notebook-docs-store.js';
import { ingestNotebookDocument } from '../src/lib/kg-adapters.js';
import { resolveEntityMention } from '../src/lib/kg-resolution.js';
import { assertClaim } from '../src/lib/kg-claims.js';
import { retrieveKnowledge, fuseNotebookAndKg } from '../src/lib/kg-retrieval.js';
import { createLocalEmbedder } from '../src/lib/kg-semantic.js';
import { excerptHash } from '../src/lib/kg-normalize.js';

// ── deterministic local "embedding" with a synonym table (no model) ─────────
const DIM = 64;
const SYN = { automobile: 'car', voiture: 'car', vehicule: 'car', auto: 'car', patron: 'boss', dirigeant: 'boss', directeur: 'boss', directrice: 'boss', pdg: 'boss' };
export function fakeEmbed(text) {
  const v = new Array(DIM).fill(0);
  for (const raw of String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []) {
    const tok = SYN[raw] ?? raw;
    let h = 0;
    for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map(x => x / norm);
}
export const fakeLocalEmbedder = () => createLocalEmbedder({ embedOne: async (t) => fakeEmbed(t), model: 'fake-local-64', provider: 'local' });

function memoryVectorStore() {
  const rows = new Map();
  return {
    upsert: async (list) => { for (const r of list) rows.set(r.chunk_id, r); },
    search: async (v, { notebookId, sourceIds, limit }) => [...rows.values()]
      .filter(r => r.notebook_id === notebookId && (!sourceIds || sourceIds.includes(r.source_id)))
      .map(r => ({ chunk_id: r.chunk_id, notebook_id: r.notebook_id, source_id: r.source_id, version_id: r.version_id, score: Math.max(0, Math.min(1, r.vector.reduce((n, x, i) => n + x * v[i], 0))) }))
      .sort((a, b) => b.score - a.score).slice(0, limit),
    delete: async (s) => { for (const [k, r] of rows) if (s.chunkIds ? s.chunkIds.includes(k) : (r.notebook_id === s.notebookId && (!s.sourceId || r.source_id === s.sourceId))) rows.delete(k); },
  };
}

export const DOCS = {
  D1: 'Acme Industries a nommé Alice Martin directrice générale en janvier 2010. Elle a quitté ses fonctions en juin 2015.',
  D2: 'Depuis juillet 2015, Bob Durand dirige Acme Industries en tant que président-directeur général.',
  D3: 'Le Widget X est fabriqué à Lyon et vendu 99 euros. Il est conçu par le bureau d’études de l’entreprise.',
  D4: 'Selon le rapport annuel, Chloé Petit est la directrice générale de Globex.',
  D5: 'Un communiqué affirme que David Roux est le directeur général de Globex.',
  D6: 'Le projet Phénix d’Initech est actif depuis 2021 et vise la migration des serveurs.',
  D7: 'Le siège social d’Acme Industries se situe à Nantes, près de la Loire.',
  D8: 'Le Gizmo de Globex coûte 45 euros en boutique.',
  D9: 'Eva Lambert a fondé Initech en 1999 avec Farid Benali.',
  D10: 'La voiture électrique d’Initech sera présentée au salon de Genève.',
  N1: 'La météo de demain annonce de la pluie sur la Bretagne et du soleil en Provence.',
  N2: 'Le club de football local a remporté le championnat régional après prolongation.',
  N3: 'Une recette de tarte aux pommes demande de la farine, du beurre et du sucre.',
  N4: 'Le musée municipal ouvre une exposition sur les instruments de musique anciens.',
  N5: 'La bibliothèque prolonge ses horaires d’ouverture pendant les examens.',
  N6: 'Le marché de Noël accueillera cinquante exposants sur la place centrale.',
};
export const PRIVATE_DOCS = {
  P1: 'Note confidentielle : Bob Durand quittera Acme Industries en 2027 pour rejoindre Hooli.',
};

/** Hand-labelled queries; `relevant` = documents whose content answers the question. */
export const QUERIES = [
  { id: 'Q1', kind: 'exact', query: 'Alice Martin', relevant: ['D1'] },
  { id: 'Q2', kind: 'exact', query: 'prix du Gizmo', relevant: ['D8'] },
  { id: 'Q3', kind: 'alias', query: 'Où se trouve le siège du Géant de l’Enclume ?', relevant: ['D7'] },
  { id: 'Q4', kind: 'graph', query: 'Qui dirige actuellement le fabricant du Widget X ?', relevant: ['D2', 'D3'] },
  { id: 'Q5', kind: 'temporal', query: 'directeur général actuel d’Acme Industries', relevant: ['D2'] },
  { id: 'Q6', kind: 'temporal', query: 'ancienne directrice générale d’Acme Industries', relevant: ['D1'] },
  { id: 'Q7', kind: 'temporal', query: 'Qui dirigeait Acme Industries en 2012 ?', relevant: ['D1'] },
  { id: 'Q8', kind: 'contradiction', query: 'directeur général de Globex', relevant: ['D4', 'D5'] },
  { id: 'Q9', kind: 'semantic', query: 'automobile Initech', relevant: ['D10'] },
  { id: 'Q10', kind: 'graph', query: 'Qui a fondé l’entreprise du projet Phénix ?', relevant: ['D9', 'D6'] },
  { id: 'Q11', kind: 'exact', query: 'statut du projet Phénix', relevant: ['D6'] },
  { id: 'Q12', kind: 'private', query: 'Bob Durand quittera Acme en 2027', relevant: [], privateDoc: 'P1' },
];

/**
 * Builds the world on the CURRENT temporary database (initSqlite already done
 * by the caller) and a KG store opened on it.
 */
export async function buildWorld({ tmpDir, store }) {
  const enc = (s) => new TextEncoder().encode(s);
  const svc = createNotebookDocumentService({
    embedText: async (t) => fakeEmbed(t), embeddingModel: 'fake-local-64', lancedbPath: `${tmpDir}/nb.lance`, vectorStore: memoryVectorStore(),
    embedFormat: {}, localComplete: async () => '', allowedRoots: [tmpDir],
  });
  const nb = `kg5-public-${crypto.randomUUID().slice(0, 8)}`;
  const nbPrivate = `kg5-private-${crypto.randomUUID().slice(0, 8)}`;
  createNotebook({ id: nb, title: 'KG-5 public' });
  createNotebook({ id: nbPrivate, title: 'KG-5 private' });
  setNotebookPrivacy(nbPrivate, { privacy: true, egressPolicy: 'local_only' });
  const docIds = {};
  const docKey = {};
  for (const [key, text] of Object.entries(DOCS)) {
    const r = await svc.importDocument({ notebookId: nb, filename: `${key}.txt`, bytes: enc(text) });
    docIds[key] = r.documentId ?? r.document?.documentId ?? r.id;
  }
  for (const [key, text] of Object.entries(PRIVATE_DOCS)) {
    const r = await svc.importDocument({ notebookId: nbPrivate, filename: `${key}.txt`, bytes: enc(text) });
    docIds[key] = r.documentId ?? r.document?.documentId ?? r.id;
  }
  for (const [k, id] of Object.entries(docIds)) docKey[id] = k;

  // KG sources: one per Notebook document (public read contracts only)
  const src = {};
  for (const [key, id] of Object.entries(docIds)) {
    const notebookId = key.startsWith('P') ? nbPrivate : nb;
    const ingest = ingestNotebookDocument(store, { document: getDocument(id), notebook: getNotebook(notebookId) });
    const chunk = getCurrentChunkRows(id)[0];
    src[key] = { ...ingest, chunkId: chunk.chunkId, text: chunk.text, notebookId };
  }
  const evidence = (key, excerpt) => {
    const s = src[key];
    const at = s.text.indexOf(excerpt);
    if (at < 0) throw new Error(`excerpt not in ${key}: ${excerpt}`);
    return { sourceId: s.sourceId, sourceRefId: s.sourceRefId, excerpt, locatorKind: 'CHUNK', chunkId: s.chunkId, charStart: at, charEnd: at + excerpt.length };
  };
  const ent = (label, type, key, extra = {}) => resolveEntityMention(store, { label, type, sourceRefId: src[key].sourceRefId, ...extra }).entityId;

  const acme = ent('Acme Industries', 'ORGANIZATION', 'D1', { identifiers: [{ scheme: 'domain', value: 'acme.example' }] });
  resolveEntityMention(store, { label: 'Acme Industries', type: 'ORGANIZATION', aliases: ['Géant de l’Enclume'], identifiers: [{ scheme: 'domain', value: 'acme.example' }], sourceRefId: src.D7.sourceRefId });
  const globex = ent('Globex', 'ORGANIZATION', 'D4', { identifiers: [{ scheme: 'domain', value: 'globex.example' }] });
  const initech = ent('Initech', 'ORGANIZATION', 'D6', { identifiers: [{ scheme: 'domain', value: 'initech.example' }] });
  const alice = ent('Alice Martin', 'PERSON', 'D1');
  const bob = ent('Bob Durand', 'PERSON', 'D2');
  const chloe = ent('Chloé Petit', 'PERSON', 'D4');
  const david = ent('David Roux', 'PERSON', 'D5');
  const eva = ent('Eva Lambert', 'PERSON', 'D9');
  const farid = ent('Farid Benali', 'PERSON', 'D9');
  const widget = ent('Widget X', 'PRODUCT', 'D3');
  const gizmo = ent('Gizmo', 'PRODUCT', 'D8');
  const phenix = ent('Phénix', 'PROJECT', 'D6');
  const car = ent('Voiture électrique d’Initech', 'PRODUCT', 'D10');
  const nantes = ent('Nantes', 'LOCATION', 'D7');
  const hooli = ent('Hooli', 'ORGANIZATION', 'P1');

  const det = (subjectEntityId, predicate, objectOrValue, ev, extra = {}) => assertClaim(store, {
    subjectEntityId, predicate, ...(typeof objectOrValue === 'string' ? { objectEntityId: objectOrValue } : { value: objectOrValue }),
    extractionMethod: 'DETERMINISTIC', evidence: Array.isArray(ev) ? ev : [ev], ...extra,
  });
  det(acme, 'ceo', alice, evidence('D1', 'Acme Industries a nommé Alice Martin directrice générale en janvier 2010'), { validFrom: '2010-01-01', validTo: '2015-07-01' });
  det(acme, 'ceo', bob, evidence('D2', 'Depuis juillet 2015, Bob Durand dirige Acme Industries'), { validFrom: '2015-07-01' });
  det(globex, 'ceo', chloe, evidence('D4', 'Chloé Petit est la directrice générale de Globex'));
  det(globex, 'ceo', david, evidence('D5', 'David Roux est le directeur général de Globex'));
  det(widget, 'price', { type: 'number', value: 99, unit: 'EUR' }, evidence('D3', 'vendu 99 euros'));
  det(gizmo, 'price', { type: 'number', value: 45, unit: 'EUR' }, evidence('D8', 'Le Gizmo de Globex coûte 45 euros'));
  det(phenix, 'status', { type: 'string', value: 'actif' }, evidence('D6', 'Le projet Phénix d’Initech est actif depuis 2021'), { validFrom: '2021-01-01' });
  det(acme, 'headquarters', nantes, evidence('D7', 'Le siège social d’Acme Industries se situe à Nantes'));
  det(initech, 'founder', eva, evidence('D9', 'Eva Lambert a fondé Initech en 1999'));
  det(initech, 'founder', farid, evidence('D9', 'Eva Lambert a fondé Initech en 1999 avec Farid Benali'));
  det(initech, 'founded_on', { type: 'date', value: '1999' }, evidence('D9', 'a fondé Initech en 1999'));
  det(bob, 'employer', acme, evidence('P1', 'Bob Durand quittera Acme Industries en 2027'), { validTo: '2027-01-01' });
  det(bob, 'employer', hooli, evidence('P1', 'pour rejoindre Hooli'), { validFrom: '2027-01-01' });
  // structural relations (not claims): product → maker, project → organisation, product → maker
  // (KG-8: with the technical ref of the Notebook document they were read in — a Notebook scope needs it)
  store.upsertRelationship({ source_entity_id: widget, target_entity_id: acme, relationship_type: 'CREATED_BY', source_id: src.D3.sourceId, source_ref_id: src.D3.sourceRefId });
  store.upsertRelationship({ source_entity_id: gizmo, target_entity_id: globex, relationship_type: 'CREATED_BY', source_id: src.D8.sourceId, source_ref_id: src.D8.sourceRefId });
  store.upsertRelationship({ source_entity_id: phenix, target_entity_id: initech, relationship_type: 'PART_OF', source_id: src.D6.sourceId, source_ref_id: src.D6.sourceRefId });
  store.upsertRelationship({ source_entity_id: car, target_entity_id: initech, relationship_type: 'CREATED_BY', source_id: src.D10.sourceId, source_ref_id: src.D10.sourceRefId });

  return { svc, nb, nbPrivate, docIds, docKey, src, entities: { acme, globex, initech, alice, bob, chloe, david, eva, farid, widget, gizmo, phenix, car, nantes, hooli } };
}

/**
 * Documents cited by KG results, in rank order: first the evidence of claim
 * results (what supports an answer), then the provenance of entity / source
 * results (where something is merely mentioned).
 */
export function kgDocuments(world, result) {
  const docs = [];
  const add = (r) => {
    for (const c of r.citations ?? []) {
      const key = c.sourceRef?.adapter === 'notebook_document' ? world.docKey[c.sourceRef.ref] : null;
      if (key && !docs.includes(key)) docs.push(key);
    }
  };
  for (const r of result.results) if (r.resultType === 'claim') add(r);
  // entities directly matched by the query (not graph neighbours) and matched sources
  for (const r of result.results) if (r.resultType === 'source' || (r.resultType === 'entity' && r.graphDistance === 0)) add(r);
  return docs;
}

export async function notebookDocuments(world, query, k) {
  const r = await world.svc.search(world.nb, query, { topK: k });
  const docs = [];
  for (const hit of r.results ?? []) {
    const key = world.docKey[hit.sourceId];
    if (key && !docs.includes(key)) docs.push(key);
  }
  return docs;
}

export function precisionRecall(ranked, relevant, k) {
  const top = ranked.slice(0, k);
  const hits = top.filter(d => relevant.includes(d)).length;
  return { precision: top.length ? hits / top.length : 0, recall: relevant.length ? hits / relevant.length : 1, hits, returned: top.length };
}

/**
 * Every citation must resolve to the ORIGINAL source: active KG source, its
 * Notebook document (public read), the cited chunk, and the excerpt inside it.
 */
export function citationCorrect(world, store, citation) {
  const source = store.getSource(citation.sourceId);
  if (!source || source.status !== 'ACTIVE') return false;
  if (!citation.sourceRef) return citation.locator?.kind === 'SOURCE';
  const ref = store.getSourceRef(citation.sourceRef.sourceRefId);
  if (!ref || ref.source_id !== citation.sourceId) return false;
  if (ref.adapter !== 'notebook_document') return true;
  const doc = getDocument(ref.source_ref);
  if (!doc) return false;
  if (!citation.locator?.chunkId) return citation.locator?.kind === 'SOURCE';
  const chunk = getChunkAnyVersion(doc.notebookId, citation.locator.chunkId);
  if (!chunk || chunk.sourceId !== doc.documentId) return false;
  if (citation.evidenceId) {
    const ev = store.getEvidence(citation.evidenceId);
    if (!ev || !chunk.text.includes(ev.content) || ev.excerpt_hash !== excerptHash(ev.content)) return false;
    if (citation.locator.charStart !== null && chunk.text.slice(citation.locator.charStart, citation.locator.charEnd) !== ev.content) return false;
  }
  return true;
}

/** Runs every method on every query and aggregates the metrics. */
export async function evaluate(world, store, { k = 5, semantic = null } = {}) {
  const methods = ['notebook', 'kg_exact', 'kg_fts', 'kg_semantic', 'kg_graph', 'kg_hybrid', 'notebook_plus_kg'];
  const rows = [];
  const citationStats = { total: 0, correct: 0 };
  const privacy = { privateCitations: 0, checkedResults: 0 };
  const latency = Object.fromEntries(methods.map(m => [m, []]));
  const contextChars = [];
  for (const q of QUERIES) {
    const ranked = {};
    let t = performance.now();
    ranked.notebook = await notebookDocuments(world, q.query, k);
    latency.notebook.push(performance.now() - t);
    let hybridResult = null;
    for (const mode of ['exact', 'fts', 'semantic', 'graph', 'hybrid']) {
      t = performance.now();
      // same visibility as the Notebook baseline: local, this notebook's documents only (Notebook documents are local-only)
      const r = await retrieveKnowledge(store, { query: q.query, mode, semantic, now: '2026-10-07', includePrivate: true, scope: { notebookId: world.nb } });
      latency[`kg_${mode}`].push(performance.now() - t);
      ranked[`kg_${mode}`] = kgDocuments(world, r);
      for (const res of r.results) {
        privacy.checkedResults++;
        for (const c of res.citations ?? []) {
          citationStats.total++;
          if (citationCorrect(world, store, c)) citationStats.correct++;
          if (c.sourceId === world.src.P1.sourceId) privacy.privateCitations++; // another notebook's private document
        }
      }
      if (JSON.stringify(r).includes('confidentielle') || JSON.stringify(r).includes('Hooli')) privacy.privateCitations++;
      if (mode === 'hybrid') { hybridResult = r; contextChars.push(r.context.chars); }
    }
    ranked.notebook_plus_kg = fuseNotebookAndKg(ranked.notebook, ranked.kg_hybrid);
    latency.notebook_plus_kg.push(latency.notebook.at(-1) + latency.kg_hybrid.at(-1));
    rows.push({ query: q, ranked, hybrid: hybridResult });
  }
  const scored = rows.filter(r => r.query.relevant.length > 0);
  const metrics = {};
  for (const m of methods) {
    const pr = scored.map(r => precisionRecall(r.ranked[m], r.query.relevant, k));
    metrics[m] = {
      precisionAtK: +(pr.reduce((s, x) => s + x.precision, 0) / pr.length).toFixed(3),
      recallAtK: +(pr.reduce((s, x) => s + x.recall, 0) / pr.length).toFixed(3),
      latencyMsMedian: +median(latency[m]).toFixed(2),
      perKind: Object.fromEntries([...new Set(scored.map(r => r.query.kind))].map(kind => {
        const sub = scored.filter(r => r.query.kind === kind).map(r => precisionRecall(r.ranked[m], r.query.relevant, k));
        return [kind, { recall: +(sub.reduce((s, x) => s + x.recall, 0) / sub.length).toFixed(3) }];
      })),
    };
  }
  return {
    k, queries: QUERIES.length, scoredQueries: scored.length, metrics,
    citationCorrectness: { ...citationStats, rate: citationStats.total ? +(citationStats.correct / citationStats.total).toFixed(4) : 1 },
    privacy, contextChars: { median: median(contextChars), max: Math.max(...contextChars) }, rows,
  };
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
}
