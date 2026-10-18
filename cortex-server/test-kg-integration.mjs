// Knowledge Graph V1 — KG-7 Notebook + Neurone integration (temporary databases only).
//
// Real Notebook document service (frozen, only used) and real neuron page
// store on a temporary SQLite file; Article Canonical neurons built with the
// real canonical-article.js; AI histories from the NB-4 fixtures (no real
// export is available). The "local model" is a deterministic fixture that
// answers like a local completion (provider 'local') — no network, no model.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, getDatabase, createNotebook, setNotebookPrivacy, savePageToStore, deletePageFromStore } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createAiHistoryService } from './src/lib/notebook-ai-history.js';
import { buildCanonicalArticle, buildArticleNeurons } from './src/lib/canonical-article.js';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { retrieveKnowledge } from './src/lib/kg-retrieval.js';
import { viewClaim, viewSource, viewEntity } from './src/lib/kg-view.js';
import { createNotebookReader, createNeuronReader, syncNotebook, syncNotebookDocument, syncNeurons, reopenCitation, verifyOpenTarget } from './src/lib/kg-integration.js';
import { createKnowledgeGraphRoute } from './src/routes/kg.js';
import { fakeEmbed } from './fixtures/kg5-retrieval-world.mjs';
import * as F from './nb4-fixtures.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg7-'));
const DB = path.join(TMP, 'world.db');
const NOW = '2026-10-08';
let store;
let svc;
let ai;
let readers;
const nb = {};
const docs = {};
const pages = {};
const enc = (s) => new TextEncoder().encode(s);

// ── deterministic "local model" (fixture) ──────────────────────────────────
let extractCalls = 0;
const localExtract = async (messages) => {
  extractCalls++;
  const text = messages[1].content.replace(/^<<<SOURCE\n/, '').replace(/\nSOURCE>>>$/, '');
  const claims = [];
  for (const m of text.matchAll(/(\p{Lu}\p{L}+ \p{Lu}\p{L}+) dirige (\p{Lu}\p{L}+(?: \p{Lu}\p{L}+)?)/gu)) {
    claims.push({ subject: { label: m[2], type: 'ORGANIZATION' }, predicate: 'ceo', object: { label: m[1], type: 'PERSON' }, quote: m[0], confidence: 0.9 });
  }
  for (const m of text.matchAll(/(\p{Lu}\p{L}+ \p{Lu}\p{L}+) a fondé (\p{Lu}\p{L}+(?: \p{Lu}\p{L}+)?)/gu)) {
    claims.push({ subject: { label: m[2], type: 'ORGANIZATION' }, predicate: 'founder', object: { label: m[1], type: 'PERSON' }, quote: m[0], confidence: 0.9 });
  }
  return { text: JSON.stringify({ claims }), provider: 'local', model: 'fixture-local-extractor' };
};

function memoryVectorStore() {
  const rows = new Map();
  return {
    upsert: async (list) => { for (const r of list) rows.set(r.chunk_id, r); },
    search: async (v, { notebookId, limit }) => [...rows.values()].filter(r => r.notebook_id === notebookId).slice(0, limit)
      .map(r => ({ chunk_id: r.chunk_id, notebook_id: r.notebook_id, source_id: r.source_id, version_id: r.version_id, score: 0.5 })),
    delete: async (s) => { for (const [k, r] of rows) if (s.chunkIds ? s.chunkIds.includes(k) : (r.notebook_id === s.notebookId && (!s.sourceId || r.source_id === s.sourceId))) rows.delete(k); },
  };
}

// ── Notebook + Neurone source tables: fingerprint (no backflow) ────────────
function sourceFingerprint() {
  const db = getDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kg\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map(r => r.name);
  const h = crypto.createHash('sha256');
  for (const t of tables) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM "${t}"`).all(); } catch { continue; }
    h.update(t);
    h.update(JSON.stringify(rows.map(r => JSON.stringify(r)).sort()));
  }
  return { tables: tables.length, hash: h.digest('hex') };
}
/** Runs a KG sync and proves Notebook / neurons were not touched by it. */
async function noBackflow(fn) {
  const before = sourceFingerprint();
  const r = await fn();
  assert.deepEqual(sourceFingerprint(), before, 'the sync wrote nothing into Notebook / neuron tables');
  return r;
}
const kgCounts = () => Object.fromEntries(['kg_sources', 'kg_source_refs', 'kg_entities', 'kg_aliases', 'kg_entity_identifiers', 'kg_claims', 'kg_evidence', 'kg_claim_evidence', 'kg_relationships', 'kg_claim_conflicts']
  .map(t => [t, store.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
const syncAll = async () => noBackflow(async () => ({
  neurons: syncNeurons(store, readers.neuron),
  notebooks: await Promise.all([nb.pub, nb.a, nb.b].map(id => syncNotebook(store, readers.notebook, id, { extract: localExtract }))),
}));
const claimOf = (subject, predicate, object) => store.prepare(`SELECT c.* FROM kg_claims c JOIN kg_entities s ON s.entity_id = c.entity_id LEFT JOIN kg_entities o ON o.entity_id = c.object_entity_id
  WHERE s.name = ? AND c.predicate = ? AND (o.name = ? OR ? IS NULL)`).get(subject, predicate, object ?? null, object ?? null);
const refOf = (adapter, ref) => store.findSourceRef(adapter, ref);
const A = () => ({ includePrivate: true, scope: { notebookId: nb.a }, now: NOW });
const B = () => ({ includePrivate: true, scope: { notebookId: nb.b }, now: NOW });
const P = () => ({ includePrivate: true, scope: { notebookId: nb.pub }, now: NOW });

// ── Article Canonical: one MSN article seen through "info msn" (paste) and "info <lien>" (URL) ──
const HEADLINE = 'Le télescope Vera Rubin dévoile dix millions de galaxies';
const BODY = Array.from({ length: 6 }, (_, i) => `Paragraphe ${i + 1} : l’observatoire installé au Chili publie ${1200 + i} galaxies par degré carré.`);
const ARTICLE_URL = 'https://www.msn.com/fr-fr/actualite/sciences/le-telescope-vera-rubin/ar-AA1vera';
function articlePage(id, input, { createdAt = '2026-10-03T10:00:00.000Z' } = {}) {
  const article = buildCanonicalArticle(input);
  const { child } = buildArticleNeurons(article, { analysis: 'Résumé.', title: article.title, modelUsed: 'scripted', captureId: `cap-${id}` });
  return { id, ...child, createdAt, updatedAt: createdAt, blocks: [] };
}

before(async () => {
  initSqlite(DB);
  store = await KnowledgeGraphStore.createTestStore(DB);
  svc = createNotebookDocumentService({
    embedText: async (t) => fakeEmbed(t), embeddingModel: 'fake-local-64', lancedbPath: path.join(TMP, 'nb.lance'), vectorStore: memoryVectorStore(),
    embedFormat: {}, localComplete: async () => '', allowedRoots: [TMP],
  });
  ai = createAiHistoryService(svc, { localComplete: async () => 'ok', localModelAvailable: async () => false });
  nb.pub = 'kg7-public'; nb.a = 'kg7-nb-a'; nb.b = 'kg7-nb-b';
  createNotebook({ id: nb.pub, title: 'Public' });
  createNotebook({ id: nb.a, title: 'Carnet A' });
  createNotebook({ id: nb.b, title: 'Carnet B' });
  setNotebookPrivacy(nb.a, { privacy: true, egressPolicy: 'local_only' });
  setNotebookPrivacy(nb.b, { privacy: true, egressPolicy: 'local_only' });
  const imp = async (notebookId, filename, text) => {
    const r = await svc.importDocument({ notebookId, filename, bytes: enc(text) });
    await r.done;
    return r.documentId;
  };
  docs.D1 = await imp(nb.pub, 'acme.txt', 'Alice Martin dirige Acme Industries depuis 2020.');
  docs.A1 = await imp(nb.a, 'rapport.txt', 'Rapport annuel : Bob Durand dirige Globex Corp.');
  docs.A2 = await imp(nb.a, 'initech.txt', 'Chloé Petit a fondé Initech Labs.');
  docs.B1 = await imp(nb.b, 'rapport-copie.txt', 'Rapport annuel : Bob Durand dirige Globex Corp.');
  docs.B2 = await imp(nb.b, 'hooli.txt', 'David Roux dirige Hooli Systems.');
  // an AI history (NB-4 fixture export) in notebook A
  const conv = F.chatgptConversation({ id: 'kg7-conv', title: 'Veille', turns: [
    { role: 'user', text: 'Note : Eva Lambert dirige Pied Piper.', id: 'kg7-u1' }, { role: 'assistant', text: 'Noté.', id: 'kg7-a1' }] });
  const h = await ai.importHistory({ notebookId: nb.a, bytes: enc(F.chatgptExport([conv])), filename: 'conversations.json' });
  assert.equal(h.status, 'READY');
  // neurons: URL capture + MSN paste of the same article, an unrelated note
  pages.url = articlePage('page-url', { path: 'url', url: `${ARTICLE_URL}?ocid=msedgntp&cvid=4f2a`, title: HEADLINE, text: BODY.join('\n\n'), siteName: 'MSN', author: 'Jean Dupont', publishedAt: '2026-10-03T08:15:00Z' });
  pages.paste = articlePage('page-paste', { path: 'paste', url: ARTICLE_URL, text: [HEADLINE, 'Histoire de Jean Dupont', 'Publié le 03/10/2026 à 10:15', ...BODY].join('\r\n'), source: 'msn' }, { createdAt: '2026-10-04T10:00:00.000Z' });
  for (const p of [pages.url, pages.paste, { id: 'page-note', kind: 'note', title: 'Note', metadata: {}, createdAt: NOW, updatedAt: NOW, blocks: [] }]) savePageToStore(p);
  readers = { notebook: createNotebookReader(), neuron: createNeuronReader() };
});
after(() => {
  store?.close();
  try { getDatabase().close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Notebook public + local-only: sources, privacy, chunk-located claims (first sync)', async () => {
  const r = await syncAll();
  const nbs = Object.fromEntries(r.notebooks.map(n => [n.notebookId, n]));
  assert.equal(nbs[nb.pub].synced, 1);
  assert.equal(nbs[nb.a].synced, 3, 'two documents + the AI history');
  assert.equal(nbs[nb.b].synced, 2);
  const d1 = refOf('notebook_document', docs.D1);
  // Notebook contract: an imported document is local_only and makes its notebook local_only — the KG never loosens it
  assert.equal(readers.notebook.getNotebook(nb.pub).privacy, true);
  assert.equal(d1.privacy, 'PRIVATE');
  assert.equal(d1.egress_policy, 'local_only');
  assert.equal(refOf('notebook_document', docs.A2).privacy, 'PRIVATE');
  assert.equal(d1.provenance.notebookId, nb.pub);
  assert.equal(d1.version_ref, readers.notebook.getDocument(docs.D1).currentVersionId);
  const alice = claimOf('Acme Industries', 'ceo', 'Alice Martin');
  assert.equal(alice.status, 'HYPOTHESIS', 'a model proposal is never a fact');
  const ev = store.prepare('SELECT * FROM kg_evidence WHERE source_ref_id = ?').get(d1.source_ref_id);
  assert.equal(ev.locator_kind, 'CHUNK');
  assert.equal(ev.chunk_id, readers.notebook.getCurrentChunks(docs.D1)[0].chunkId);
  // local-only: visible in its own notebook scope only
  const own = await retrieveKnowledge(store, { query: 'Alice Martin', ...P() });
  assert.ok(own.results.some(x => x.resultType === 'claim' && x.object.label === 'Alice Martin'));
  assert.ok(!JSON.stringify((await retrieveKnowledge(store, { query: 'Alice Martin', now: NOW })).results).includes('Alice'));
  // local-only: invisible by default and for cloud, visible in its own notebook scope
  for (const vis of [{}, { provider: 'cloud' }]) {
    const d = await retrieveKnowledge(store, { query: 'Chloé Petit Initech Labs', now: NOW, ...vis });
    assert.ok(!JSON.stringify(d.results).includes('Chloé'), JSON.stringify(vis));
  }
  const scoped = await retrieveKnowledge(store, { query: 'Chloé Petit Initech Labs', ...A() });
  assert.ok(scoped.results.some(x => x.resultType === 'claim' && x.object.label === 'Chloé Petit'));
  await assert.rejects(() => retrieveKnowledge(store, { query: 'Chloé', ...A(), provider: 'cloud' }), e => e.code === 'KG_PRIVATE_NOT_FOR_CLOUD');
  // AI history (fixture): one more ref of notebook A, message chunk located, private
  const hist = store.prepare("SELECT * FROM kg_source_refs WHERE adapter = 'notebook_document' AND input_path = 'ai_history'").all();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].privacy, 'PRIVATE');
  assert.ok(claimOf('Pied Piper', 'ceo', 'Eva Lambert'), 'claim extracted from the AI history chunk');
});

test('cross-notebook isolation: one shared logical document, two refs; each notebook sees only its own evidence', async () => {
  const a1 = refOf('notebook_document', docs.A1);
  const b1 = refOf('notebook_document', docs.B1);
  assert.equal(a1.source_id, b1.source_id, 'same content → one logical source');
  assert.notEqual(a1.source_ref_id, b1.source_ref_id);
  const bob = claimOf('Globex Corp', 'ceo', 'Bob Durand');
  const evs = store.prepare("SELECT e.source_ref_id FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id WHERE ce.claim_id = ?").all(bob.claim_id);
  assert.deepEqual(new Set(evs.map(e => e.source_ref_id)), new Set([a1.source_ref_id, b1.source_ref_id]), 'one claim, one evidence per notebook chunk');
  const inA = viewClaim(store, { claimId: bob.claim_id, ...A() });
  assert.deepEqual(inA.evidence.map(e => e.sourceRef.sourceRefId), [a1.source_ref_id]);
  const inB = viewClaim(store, { claimId: bob.claim_id, ...B() });
  assert.deepEqual(inB.evidence.map(e => e.sourceRef.sourceRefId), [b1.source_ref_id]);
  // B-only claim invisible from A (and vice versa)
  assert.equal(viewClaim(store, { claimId: claimOf('Hooli Systems', 'ceo', 'David Roux').claim_id, ...A() }), null);
  assert.equal(viewClaim(store, { claimId: claimOf('Initech Labs', 'founder', 'Chloé Petit').claim_id, ...B() }), null);
  const fromA = JSON.stringify((await retrieveKnowledge(store, { query: 'David Roux Hooli Systems', ...A() })).results);
  assert.ok(!fromA.includes('Hooli') && !fromA.includes(docs.B2) && !fromA.includes(docs.B1));
  const src = viewSource(store, { sourceId: a1.source_id, ...A() });
  assert.deepEqual(src.refs.map(r => r.ref), [docs.A1]);
});

test('Neurone + Article Canonical: MSN paste and URL capture converge on ONE logical source with two technical refs', () => {
  const url = refOf('article_capture', pages.url.id);
  const paste = refOf('article_capture', pages.paste.id);
  assert.ok(url && paste);
  assert.equal(url.source_id, paste.source_id, 'one logical KG source');
  assert.deepEqual([url.input_path, paste.input_path].sort(), ['paste', 'url'], 'distinct technical provenances');
  assert.equal(refOf('article_capture', 'page-note'), null, 'a plain note is not an article');
  const src = store.getSource(url.source_id);
  assert.equal(src.canonical_url, ARTICLE_URL);
  assert.equal(src.privacy, 'STANDARD');
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM kg_sources WHERE source_type = 'ARTICLE'").get().n, 1);
  for (const p of ['author', 'publisher', 'published_on']) {
    assert.equal(store.prepare('SELECT COUNT(*) AS n FROM kg_claims WHERE predicate = ?').get(p).n, 1, `${p}: one claim`);
  }
  const author = claimOf(HEADLINE, 'author', 'Jean Dupont');
  assert.equal(author.extraction_method, 'DETERMINISTIC');
  assert.equal(author.status, 'SUPPORTED');
  // public neuron citation reopens the neuron
  const evId = store.prepare('SELECT e.evidence_id FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id WHERE ce.claim_id = ?').get(author.claim_id).evidence_id;
  const cite = reopenCitation(store, readers, { evidenceId: evId });
  assert.equal(cite.open.kind, 'neuron');
  assert.ok([pages.url.id, pages.paste.id].includes(cite.open.pageId));
  assert.equal(cite.open.available, true);
});

test('Article Canonical divergence is recorded and shown, never masked', () => {
  const changed = articlePage('page-url-v2', { path: 'url', url: ARTICLE_URL, title: HEADLINE, text: `${BODY.join('\n\n')}\n\nMise à jour : un paragraphe ajouté.`, siteName: 'MSN', author: 'Jean Dupont', publishedAt: '2026-10-03T08:15:00Z' },
    { createdAt: '2026-10-05T10:00:00.000Z' });
  savePageToStore(changed);
  const r = syncNeurons(store, readers.neuron);
  const row = r.results.find(x => x.pageId === changed.id);
  assert.deepEqual(row.divergences, ['content_hash_differs']);
  const ref = refOf('article_capture', changed.id);
  assert.equal(ref.source_id, refOf('article_capture', pages.url.id).source_id, 'same canonical URL → same logical source (Article Canonical order)');
  const view = viewSource(store, { sourceId: ref.source_id });
  assert.deepEqual(view.refs.find(x => x.ref === changed.id).divergences, ['content_hash_differs'], 'the divergence is visible on the source view');
  deletePageFromStore(changed.id);
  syncNeurons(store, readers.neuron);
});

test('re-import is idempotent: no duplicate source, ref, entity, alias, claim or evidence; no second model call', async () => {
  const before = kgCounts();
  const calls = extractCalls;
  await syncAll();
  await syncAll();
  assert.deepEqual(kgCounts(), before);
  assert.equal(extractCalls, calls, 'chunks already extracted are not sent to the model again');
});

test('reindex: same chunks → nothing changes; a new version → old evidence outdated (still reopenable), new claims', async () => {
  const before = kgCounts();
  const re = await svc.reindexDocument(nb.pub, docs.D1);
  assert.equal(re.ok, true);
  const r1 = await noBackflow(() => syncNotebookDocument(store, readers.notebook, docs.D1, { extract: localExtract }));
  assert.equal(r1.evidenceOutdated, 0);
  assert.deepEqual(kgCounts(), before, 're-embedding changes nothing in the KG');
  // new version of the same document (same name, new content)
  const oldChunk = readers.notebook.getCurrentChunks(docs.D1)[0].chunkId;
  const v2 = await svc.importDocument({ notebookId: nb.pub, filename: 'acme.txt', bytes: enc('Depuis 2024, Bob Durand dirige Acme Industries.') });
  await v2.done;
  assert.equal(v2.documentId, docs.D1, 'a new version of the same Notebook document');
  const r2 = await noBackflow(() => syncNotebookDocument(store, readers.notebook, docs.D1, { extract: localExtract }));
  assert.equal(r2.evidenceOutdated, 1);
  assert.equal(refOf('notebook_document', docs.D1).version_ref, readers.notebook.getDocument(docs.D1).currentVersionId);
  assert.equal(claimOf('Acme Industries', 'ceo', 'Alice Martin').status, 'INVALIDATED', 'its only evidence is in a superseded version');
  assert.equal(claimOf('Acme Industries', 'ceo', 'Bob Durand').status, 'HYPOTHESIS');
  const old = store.prepare('SELECT evidence_id, status FROM kg_evidence WHERE chunk_id = ?').get(oldChunk);
  assert.equal(old.status, 'INVALIDATED');
  const cite = reopenCitation(store, readers, { evidenceId: old.evidence_id, ...P() });
  assert.equal(cite.open.available, true, 'the superseded chunk still resolves in Notebook');
  assert.equal(cite.open.superseded, true);
  const again = kgCounts();
  await syncNotebookDocument(store, readers.notebook, docs.D1, { extract: localExtract });
  assert.deepEqual(kgCounts(), again, 'reindex sync is idempotent');
});

test('delete → invalidation: ref, evidence, claims recomputed; shared logical source survives; nothing deleted; no orphan citation', async () => {
  const before = kgCounts();
  const bob = claimOf('Globex Corp', 'ceo', 'Bob Durand');
  const david = claimOf('Hooli Systems', 'ceo', 'David Roux');
  const b1 = refOf('notebook_document', docs.B1);
  const b2 = refOf('notebook_document', docs.B2);
  assert.equal((await svc.removeDocument(nb.b, docs.B1)).ok, true);
  assert.equal((await svc.removeDocument(nb.b, docs.B2)).ok, true);
  const r = await noBackflow(() => syncNotebook(store, readers.notebook, nb.b));
  assert.equal(r.invalidated, 2);
  assert.equal(refOf('notebook_document', docs.B1).status, 'INVALIDATED');
  assert.equal(store.getSource(b1.source_id).status, 'ACTIVE', 'notebook A still has this document');
  assert.equal(store.getSource(b2.source_id).status, 'DELETED', 'its last provenance is gone');
  assert.equal(store.prepare('SELECT status FROM kg_evidence WHERE source_ref_id = ?').get(b1.source_ref_id).status, 'SOURCE_MISSING');
  assert.equal(store.getClaim(bob.claim_id).status, 'HYPOTHESIS', 'still supported by notebook A');
  assert.equal(store.getClaim(david.claim_id).status, 'INVALIDATED', 'no remaining evidence');
  assert.deepEqual(kgCounts(), before, 'no row deleted (no destructive cascade)');
  // B scope: nothing left; A scope unchanged
  assert.equal(viewClaim(store, { claimId: bob.claim_id, ...B() }), null);
  assert.equal(viewClaim(store, { claimId: bob.claim_id, ...A() }).evidence.length, 1);
  // no orphan citation: every ACTIVE evidence of a notebook ref reopens its Notebook chunk
  const active = store.prepare("SELECT e.evidence_id FROM kg_evidence e JOIN kg_source_refs r ON r.source_ref_id = e.source_ref_id WHERE r.adapter = 'notebook_document' AND e.status = 'ACTIVE'").all();
  assert.ok(active.length >= 4);
  for (const { evidence_id: id } of active) {
    const c = reopenCitation(store, readers, { evidenceId: id, includePrivate: true, scope: { all: true } });
    assert.equal(c.open.available, true, id);
  }
  // retrieval cites nothing from the deleted documents
  const res = await retrieveKnowledge(store, { query: 'Bob Durand Globex Corp David Roux Hooli', includePrivate: true, scope: { all: true }, now: NOW });
  const text = JSON.stringify({ results: res.results, context: res.context });
  assert.ok(text.includes(docs.A1), 'notebook A still cited');
  assert.ok(!text.includes(docs.B1) && !text.includes(docs.B2));
});

test('neuron deleted: the capture ref follows; the logical article and its metadata claims survive through the other capture', () => {
  const author = claimOf(HEADLINE, 'author', 'Jean Dupont');
  const paste = refOf('article_capture', pages.paste.id);
  deletePageFromStore(pages.paste.id);
  const r = syncNeurons(store, readers.neuron);
  assert.equal(r.invalidated, 1);
  assert.equal(refOf('article_capture', pages.paste.id).status, 'INVALIDATED');
  assert.equal(store.getSource(paste.source_id).status, 'ACTIVE');
  assert.equal(store.getClaim(author.claim_id).status, 'SUPPORTED', 'metadata evidence moved to the remaining capture');
  const ev = store.prepare('SELECT e.* FROM kg_claim_evidence ce JOIN kg_evidence e ON e.evidence_id = ce.evidence_id WHERE ce.claim_id = ?').get(author.claim_id);
  assert.equal(ev.source_ref_id, refOf('article_capture', pages.url.id).source_ref_id);
  assert.equal(reopenCitation(store, readers, { evidenceId: ev.evidence_id }).open.pageId, pages.url.id);
});

test('citation reopen through the API: right notebook, document, version, chunk, locator; other notebook = 404', async () => {
  const app = createKnowledgeGraphRoute(store, { readers });
  const post = async (p, body) => { const res = await app.request(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }); return { status: res.status, body: await res.json() }; };
  const a2 = refOf('notebook_document', docs.A2);
  const ev = store.prepare("SELECT * FROM kg_evidence WHERE source_ref_id = ? AND status = 'ACTIVE'").get(a2.source_ref_id);
  const r = await post('/view/citation', { evidenceId: ev.evidence_id, includePrivate: true, scope: { notebookId: nb.a } });
  assert.equal(r.status, 200);
  const chunk = readers.notebook.getCurrentChunks(docs.A2)[0];
  assert.deepEqual(r.body.open, { kind: 'notebook_document', notebookId: nb.a, documentId: docs.A2, versionId: chunk.versionId, origin: 'file', chunkId: chunk.chunkId, page: null,
    charStart: ev.char_start, charEnd: ev.char_end, messageId: null, available: true, superseded: false, chunkVersionId: chunk.versionId });
  assert.equal(chunk.text.slice(ev.char_start, ev.char_end), ev.content, 'the locator points at the exact quote');
  assert.equal(svc.verifyCitation(nb.a, { chunkId: r.body.open.chunkId, versionId: r.body.open.versionId }).valid, true, 'Notebook\'s own citation check accepts it');
  assert.equal((await post('/view/citation', { evidenceId: ev.evidence_id, includePrivate: true, scope: { notebookId: nb.b } })).status, 404);
  assert.equal((await post('/view/citation', { evidenceId: ev.evidence_id })).status, 404);
  // a verification on a wrong notebook never says "available"
  assert.equal(verifyOpenTarget(readers, { ...r.body.open, notebookId: nb.b }).available, false);
});

test('Strict Local: a non-local completion stores nothing', async () => {
  const before = kgCounts();
  const doc = await svc.importDocument({ notebookId: nb.pub, filename: 'cloud.txt', bytes: enc('Frank Moreau dirige Umbrella Corp.') });
  await doc.done;
  const cloud = async () => ({ text: JSON.stringify({ claims: [] }), provider: 'openai' });
  await assert.rejects(() => syncNotebookDocument(store, readers.notebook, doc.documentId, { extract: cloud }), e => e.code === 'KG_STRICT_LOCAL_REQUIRED');
  assert.equal(kgCounts().kg_claims, before.kg_claims);
  assert.equal(claimOf('Umbrella Corp', 'ceo', 'Frank Moreau'), undefined);
});

test('entity view in a notebook scope: aliases and provenance only from that notebook', () => {
  const globex = store.prepare("SELECT entity_id FROM kg_entities WHERE name = 'Globex Corp'").get().entity_id;
  const v = viewEntity(store, { entityId: globex, ...A() });
  assert.ok(v.provenance.every(p => p.ref === docs.A1), JSON.stringify(v.provenance));
  assert.equal(viewEntity(store, { entityId: globex, ...B() }), null, 'B no longer has any provenance for it');
});
