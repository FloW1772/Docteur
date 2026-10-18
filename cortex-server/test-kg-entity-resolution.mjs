// Knowledge Graph V1 — KG-3B/C: normalisation + entity resolution, Article
// Canonical convergence (MSN paste + URL extraction → one logical source, two
// technical refs) and Notebook source preservation.
// Temporary databases only; no network, no model, no cloud.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelKey, looseKey, tokenKey, labelKeys, normalizeIdentifier, entityTypesCompatible } from './src/lib/kg-normalize.js';
import { KnowledgeGraphStore } from './src/lib/kg-store.js';
import { resolveEntityMention, mergeEntities, confirmResolution, rejectResolution, reverseResolution } from './src/lib/kg-resolution.js';
import { ingestArticleNeuron, ingestNotebookDocument } from './src/lib/kg-adapters.js';
import { buildCanonicalArticle, articleInputFromExtraction, buildArticleNeurons } from './src/lib/canonical-article.js';
import { extractArticleCandidatesFromHtml, closeDeepCaptureBrowserForTests } from './src/lib/deep-capture.js';
import { initSqlite, getDatabase, createNotebook, getNotebook, setNotebookPrivacy } from './src/lib/sqlite.js';
import { ensureNotebookDocsSchema, insertDocument, updateDocument, getDocument, listDocuments } from './src/lib/notebook-docs-store.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg3bc-'));
after(() => {
  closeDeepCaptureBrowserForTests();
  try { getDatabase()?.close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Every test checks this at the end: the system never confirmed a merge on its own.
function assertNoForcedMerge(store) {
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_entity_resolutions WHERE decision = 'CONFIRMED' AND actor = 'SYSTEM'").get().n, 0, 'ambiguous forced merges = 0');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_entities WHERE status = 'MERGED' AND entity_id NOT IN (SELECT source_entity_id FROM kg_entity_resolutions WHERE decision = 'CONFIRMED' AND actor = 'USER')").get().n, 0);
}

async function storeWithSource(name = 'Source A') {
  const store = await KnowledgeGraphStore.createTempStore();
  const sourceId = store.upsertSource({ source_type: 'ARTICLE', name, logical_key: `test:${name}` }).id;
  const refId = store.upsertSourceRef({ source_id: sourceId, adapter: 'manual', source_ref: `ref:${name}` }).id;
  return { store, sourceId, refId };
}

function newSource(store, name) {
  const sourceId = store.upsertSource({ source_type: 'ARTICLE', name, logical_key: `test:${name}` }).id;
  const refId = store.upsertSourceRef({ source_id: sourceId, adapter: 'manual', source_ref: `ref:${name}` }).id;
  return { sourceId, refId };
}

const count = (store, table, where = '1 = 1', ...args) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;

// ════════════════════════════════════════════════════════════════════════════
// KG-3B normalisation
// ════════════════════════════════════════════════════════════════════════════

test('normalisation: Unicode NFC/NFD, NFKC forms, invisible characters', () => {
  assert.equal(labelKey('École'), labelKey('École'), 'NFD = NFC');
  assert.equal(labelKey('ＡＢＣ'), 'abc', 'full-width (NFKC)');
  assert.equal(labelKey('Zero​width﻿'), 'zerowidth');
  assert.equal(labelKey('Soft­hyphen'), 'softhyphen');
});

test('normalisation: accents kept in the strict key, folded in the loose key (French)', () => {
  assert.notEqual(labelKey('Éric'), labelKey('Eric'));
  assert.equal(looseKey('Éric'), looseKey('Eric'));
  assert.equal(looseKey('Société Générale'), 'societe generale');
  assert.equal(looseKey('ÇA VA À NOËL'), 'ca va a noel');
  assert.equal(looseKey('Αθήνα'), 'αθηνα', 'Greek tonos');
  assert.equal(looseKey('АЛЁНА'), 'алена', 'Cyrillic diaeresis');
});

test('normalisation: apostrophes, hyphens and dashes, spaces, tabs, newlines', () => {
  assert.equal(labelKey('L’Oréal'), labelKey("L'Oréal"));
  assert.equal(labelKey('L‘Oréal'), labelKey("L'Oréal"));
  assert.equal(labelKey('Jean‐Pierre'), labelKey('Jean-Pierre'), 'U+2010 hyphen');
  assert.equal(labelKey('Jean–Pierre'), labelKey('Jean-Pierre'), 'en dash');
  assert.equal(labelKey('  Jean \t\n  Martin\r\n'), 'jean martin');
  assert.equal(labelKey('Jean Martin'), 'jean martin', 'NBSP');
});

test('normalisation: case folding (full), non-Latin scripts preserved, emoji kept, original untouched', () => {
  assert.equal(labelKey('STRASSE'), labelKey('Straße'));
  assert.equal(labelKey('ÉCOLE'), labelKey('école'));
  assert.notEqual(looseKey('東京'), looseKey('京都'));
  assert.equal(looseKey('हिन्दी'), labelKey('हिन्दी'), 'Devanagari vowel signs are part of the letters, never stripped');
  assert.equal(looseKey('دبي'), 'دبي');
  assert.equal(labelKey('🚀 Rocket'), '🚀 rocket');
  assert.equal(labelKey('❤️ Love'), labelKey('❤ Love'), 'variation selector ignored');
  assert.equal(tokenKey('Martin, Jean'), tokenKey('Jean Martin'));
  const original = '  L’Oréal​ ';
  const keys = labelKeys(original);
  assert.equal(keys.original, original, 'the original form is returned untouched');
});

test('normalisation: identifiers per scheme; invalid values refused, never guessed', () => {
  assert.equal(normalizeIdentifier('doi', 'https://doi.org/10.1000/XYZ123').value, normalizeIdentifier('doi', 'doi:10.1000/xyz123').value);
  assert.equal(normalizeIdentifier('isbn', '0-306-40615-2').value, normalizeIdentifier('isbn', '978-0-306-40615-7').value, 'ISBN-10 → ISBN-13');
  assert.equal(normalizeIdentifier('isbn', '0-306-40615-3'), null, 'bad checksum');
  assert.equal(normalizeIdentifier('orcid', '0000-0002-1825-0097').value, '0000-0002-1825-0097');
  assert.equal(normalizeIdentifier('orcid', '0000-0002-1825-0098'), null);
  assert.equal(normalizeIdentifier('domain', 'https://WWW.Apple.com/fr/').value, 'apple.com');
  assert.equal(normalizeIdentifier('domain', 'münchen.de').value, 'xn--mnchen-3ya.de');
  assert.equal(normalizeIdentifier('domain', '192.168.1.1'), null);
  assert.equal(normalizeIdentifier('url', 'https://Example.com/a/?utm_source=x&b=1#f').value, 'https://example.com/a?b=1', 'Article Canonical URL contract');
  assert.equal(normalizeIdentifier('wikidata', 'https://www.wikidata.org/wiki/q312').value, 'Q312');
  const email = normalizeIdentifier('email_sha256', 'Jane.Doe@Example.org');
  assert.match(email.value, /^[a-f0-9]{64}$/);
  assert.equal(email.original, email.value, 'the raw e-mail is not kept');
  assert.equal(normalizeIdentifier('external', 'noprefix'), null);
  assert.equal(normalizeIdentifier('made_up_scheme', 'x'), null);
});

// ════════════════════════════════════════════════════════════════════════════
// KG-3C entity resolution
// ════════════════════════════════════════════════════════════════════════════

test('stable identifiers: different labels + same identifier → same entity; label kept; identifier stored once', async () => {
  const { store, sourceId, refId } = await storeWithSource();
  const b = newSource(store, 'Source B');
  const first = resolveEntityMention(store, { label: 'Microsoft', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'microsoft.com' }], sourceRefId: refId });
  assert.equal(first.outcome, 'CREATED');
  const second = resolveEntityMention(store, { label: 'Microsoft Corporation', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'https://www.microsoft.com/fr-fr/' }], sourceRefId: b.refId });
  assert.equal(second.outcome, 'MATCHED_EXISTING');
  assert.equal(second.method, 'STABLE_IDENTIFIER');
  assert.equal(second.entityId, first.entityId);
  assert.equal(store.getEntity(first.entityId).name, 'Microsoft', 'canonical label never replaced by an alias');
  assert.deepEqual(store.getAliasesForEntity(first.entityId).map(a => a.alias).sort(), ['Microsoft', 'Microsoft Corporation']);
  assert.equal(count(store, 'kg_entity_identifiers', 'entity_id = ?', first.entityId), 1, 'duplicate identifier stored once');
  assert.ok(sourceId);
  assertNoForcedMerge(store);
  store.close();
});

test('duplicate identifier: re-adding is idempotent; conflicting identifier: held by another entity → CONFLICT, never merged', async () => {
  const { store } = await storeWithSource();
  const a = store.upsertEntity({ entity_type: 'PERSON', name: 'Ada Lovelace' }).id;
  const b = store.upsertEntity({ entity_type: 'PERSON', name: 'A. Lovelace' }).id;
  assert.equal(store.addIdentifier({ entity_id: a, scheme: 'orcid', value: '0000-0002-1825-0097' }).status, 'ACTIVE');
  assert.equal(store.addIdentifier({ entity_id: a, scheme: 'orcid', value: 'https://orcid.org/0000-0002-1825-0097' }).isNew, false);
  const conflict = store.addIdentifier({ entity_id: b, scheme: 'orcid', value: '0000-0002-1825-0097' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.deepEqual(conflict.conflictsWith, [a]);
  assert.equal(store.getEntity(b).status, 'ACTIVE', 'no merge');
  assert.throws(() => store.addIdentifier({ entity_id: a, scheme: 'isbn', value: '123' }), e => e.code === 'KG_IDENTIFIER_INVALID');
  // two strong identifiers of one mention pointing at two different entities → AMBIGUOUS, both kept as candidates
  const c = store.upsertEntity({ entity_type: 'PERSON', name: 'Ada' }).id;
  store.addIdentifier({ entity_id: c, scheme: 'wikidata', value: 'Q7259' });
  const both = resolveEntityMention(store, { label: 'Ada Lovelace', type: 'PERSON', identifiers: [{ scheme: 'orcid', value: '0000-0002-1825-0097' }, { scheme: 'wikidata', value: 'Q7259' }] });
  assert.equal(both.outcome, 'AMBIGUOUS');
  assert.deepEqual(both.candidates.map(x => x.entityId).sort(), [a, c].sort());
  assert.equal(both.proposedResolutionIds.length, 2);
  // an identifier carried by an entity of an incompatible type is reported, never used
  const org = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Lovelace Ltd' }).id;
  store.addIdentifier({ entity_id: org, scheme: 'domain', value: 'lovelace.example' });
  const person = resolveEntityMention(store, { label: 'Lovelace', type: 'PERSON', identifiers: [{ scheme: 'domain', value: 'lovelace.example' }] });
  assert.equal(person.outcome, 'CREATED');
  assert.ok(person.identifierConflicts.some(x => x.heldBy === org && x.reason === 'incompatible entity type'));
  // invalid identifiers are reported, not stored
  const bad = resolveEntityMention(store, { label: 'Book', type: 'DOCUMENT', identifiers: [{ scheme: 'isbn', value: '0-306-40615-3' }] });
  assert.deepEqual(bad.rejectedIdentifiers, [{ scheme: 'isbn', reason: 'invalid for scheme' }]);
  assert.equal(count(store, 'kg_entity_identifiers', 'entity_id = ?', bad.entityId), 0);
  assertNoForcedMerge(store);
  store.close();
});

test('same entity / multiple aliases: corroborated alias resolves; the logical view gathers every alias with its provenance', async () => {
  const { store, refId } = await storeWithSource('S1');
  const s2 = newSource(store, 'S2');
  const s3 = newSource(store, 'S3');
  const ibm = resolveEntityMention(store, { label: 'IBM', type: 'ORGANIZATION', aliases: ['International Business Machines', 'Big Blue'], sourceRefId: refId });
  const watson = resolveEntityMention(store, { label: 'Thomas J. Watson', type: 'PERSON', sourceRefId: refId });
  store.upsertRelationship({ source_entity_id: watson.entityId, target_entity_id: ibm.entityId, relationship_type: 'AFFILIATED_WITH' });
  const viaAlias = resolveEntityMention(store, { label: 'International Business Machines', type: 'ORGANIZATION', sourceRefId: s2.refId, context: { relatedEntityIds: [watson.entityId] } });
  assert.equal(viaAlias.outcome, 'MATCHED_EXISTING');
  assert.equal(viaAlias.method, 'ALIAS_CORROBORATED');
  assert.equal(viaAlias.entityId, ibm.entityId);
  const viaCase = resolveEntityMention(store, { label: 'big  BLUE', type: 'ORGANIZATION', sourceRefId: s3.refId, context: { relatedEntityIds: [watson.entityId] } });
  assert.equal(viaCase.entityId, ibm.entityId);
  const view = store.getLogicalEntity(ibm.entityId);
  assert.equal(view.entity.name, 'IBM');
  const aliasRefs = new Set(view.aliases.map(a => a.source_ref_id));
  assert.equal(aliasRefs.size, 3, 'each source keeps its own alias row');
  assert.ok(view.aliases.some(a => a.alias === 'big  BLUE'), 'original form kept');
  // the same alias alone, without corroboration, is never enough
  const bare = resolveEntityMention(store, { label: 'Big Blue', type: 'ORGANIZATION' });
  assert.equal(bare.outcome, 'AMBIGUOUS');
  assert.deepEqual(bare.candidates.map(c => c.entityId), [ibm.entityId]);
  assertNoForcedMerge(store);
  store.close();
});

test('same alias / different entities: "Apple" stays ambiguous without context; a stable identifier picks the right one', async () => {
  const { store } = await storeWithSource();
  const inc = resolveEntityMention(store, { label: 'Apple Inc.', type: 'ORGANIZATION', aliases: ['Apple'], identifiers: [{ scheme: 'domain', value: 'apple.com' }] });
  const records = resolveEntityMention(store, { label: 'Apple Records', type: 'ORGANIZATION', aliases: ['Apple'], identifiers: [{ scheme: 'domain', value: 'applerecords.com' }] });
  const ambiguous = resolveEntityMention(store, { label: 'Apple', type: 'ORGANIZATION' });
  assert.equal(ambiguous.outcome, 'AMBIGUOUS');
  assert.deepEqual(ambiguous.candidates.map(c => c.entityId).sort(), [inc.entityId, records.entityId].sort());
  assert.equal(store.getEntity(ambiguous.entityId).status, 'AMBIGUOUS');
  assert.equal(store.findEntityByAlias('apple').ambiguous, true);
  const precise = resolveEntityMention(store, { label: 'Apple', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'www.apple.com' }] });
  assert.equal(precise.entityId, inc.entityId);
  assertNoForcedMerge(store);
  store.close();
});

test('homonyms: two people named "Jean Martin" with contradicting attributes stay distinct; a bare mention is ambiguous', async () => {
  const { store } = await storeWithSource();
  const doctor = resolveEntityMention(store, { label: 'Jean Martin', type: 'PERSON', context: { attributes: { birthYear: '1961', occupation: 'médecin' } } });
  const footballer = resolveEntityMention(store, { label: 'Jean MARTIN', type: 'PERSON', context: { attributes: { birthYear: '1994', occupation: 'footballeur' } } });
  assert.equal(footballer.outcome, 'CREATED');
  assert.notEqual(footballer.entityId, doctor.entityId);
  assert.ok(footballer.candidates[0].signals.contradictions.length > 0);
  assert.equal(footballer.proposedResolutionIds.length, 0, 'evidence of difference: not even proposed');
  const bare = resolveEntityMention(store, { label: 'Jean Martin', type: 'PERSON' });
  assert.equal(bare.outcome, 'AMBIGUOUS');
  assert.equal(bare.candidates.length, 2);
  const matching = resolveEntityMention(store, { label: 'Jean Martin', type: 'PERSON', context: { attributes: { birthYear: '1961' } } });
  assert.equal(matching.outcome, 'MATCHED_EXISTING');
  assert.equal(matching.entityId, doctor.entityId);
  // two organisations with similar names: candidate only
  const acme = resolveEntityMention(store, { label: 'Acme Corp', type: 'ORGANIZATION' });
  const acme2 = resolveEntityMention(store, { label: 'Acme Corp.', type: 'ORGANIZATION' });
  assert.equal(acme2.outcome, 'CREATED');
  assert.notEqual(acme2.entityId, acme.entityId);
  const proposal = store.getResolution(acme2.proposedResolutionIds[0]);
  assert.equal(proposal.method, 'SIMILARITY_CANDIDATE');
  assert.equal(proposal.decision, 'PROPOSED');
  // same tokens in another order: candidate only
  const reordered = resolveEntityMention(store, { label: 'Martin Jean', type: 'PERSON' });
  assert.ok(reordered.proposedResolutionIds.map(id => store.getResolution(id)).every(r => r.decision === 'PROPOSED'));
  assertNoForcedMerge(store);
  store.close();
});

test('cross-type collisions: person vs company, project vs product, place vs organisation stay distinct', async () => {
  const { store } = await storeWithSource();
  const pairs = [['Mercedes', 'PERSON', 'ORGANIZATION'], ['Phoenix', 'PROJECT', 'PRODUCT'], ['Paris', 'LOCATION', 'ORGANIZATION'], ['Paris', 'PLACE', 'ORGANIZATION']];
  for (const [label, t1, t2] of pairs) {
    const x = resolveEntityMention(store, { label, type: t1 });
    const y = resolveEntityMention(store, { label, type: t2 });
    assert.notEqual(x.entityId, y.entityId, `${label}: ${t1} ≠ ${t2}`);
    assert.ok(!y.candidates.some(c => c.entityId === x.entityId), 'not even a candidate');
  }
  assert.equal(entityTypesCompatible('LOCATION', 'PLACE'), true, 'the KG-2 and KG-1 names of a place are one type class');
  const city = resolveEntityMention(store, { label: 'Lyon', type: 'LOCATION', identifiers: [{ scheme: 'wikidata', value: 'Q456' }] });
  const place = resolveEntityMention(store, { label: 'Lyon', type: 'PLACE', identifiers: [{ scheme: 'wikidata', value: 'Q456' }] });
  assert.equal(place.entityId, city.entityId);
  const person = store.upsertEntity({ entity_type: 'PERSON', name: 'Mercedes' }).id;
  const org = store.upsertEntity({ entity_type: 'ORGANIZATION', name: 'Mercedes' }).id;
  assert.throws(() => mergeEntities(store, person, org, { actor: 'USER' }), e => e.code === 'KG_INCOMPATIBLE_TYPES');
  assertNoForcedMerge(store);
  store.close();
});

test('accents / case / Unicode alone never merge; with corroboration the accent-insensitive match is flagged', async () => {
  const { store, refId } = await storeWithSource();
  const sg = resolveEntityMention(store, { label: 'Société Générale', type: 'ORGANIZATION', sourceRefId: refId });
  const upper = resolveEntityMention(store, { label: 'SOCIETE GENERALE', type: 'ORGANIZATION' });
  assert.equal(upper.outcome, 'AMBIGUOUS');
  assert.equal(upper.candidates[0].signals.accentInsensitiveOnly, true);
  const ceo = store.upsertEntity({ entity_type: 'PERSON', name: 'Slawomir Krupa' }).id;
  store.upsertRelationship({ source_entity_id: ceo, target_entity_id: sg.entityId, relationship_type: 'MEMBER_OF' });
  const nfd = resolveEntityMention(store, { label: 'Société Générale'.normalize('NFD'), type: 'ORGANIZATION', context: { relatedEntityIds: [ceo] } });
  assert.equal(nfd.entityId, sg.entityId);
  assert.equal(nfd.method, 'LABEL_CONTEXT');
  assert.equal(store.getEntity(sg.entityId).name, 'Société Générale');
  assertNoForcedMerge(store);
  store.close();
});

test('ambiguity is kept: candidates preserved as PROPOSED; confirm / reject are explicit user decisions', async () => {
  const { store } = await storeWithSource();
  const a = resolveEntityMention(store, { label: 'Mistral', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'mistral.ai' }] });
  const b = resolveEntityMention(store, { label: 'Mistral', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'mistral-energie.example' }] });
  assert.equal(b.outcome, 'AMBIGUOUS', 'same label, other domain: not merged');
  const m = resolveEntityMention(store, { label: 'Mistral', type: 'ORGANIZATION' });
  assert.equal(m.outcome, 'AMBIGUOUS');
  const toA = m.proposedResolutionIds.map(id => store.getResolution(id)).find(r => r.target_entity_id === a.entityId);
  const toB = m.proposedResolutionIds.map(id => store.getResolution(id)).find(r => r.target_entity_id === b.entityId);
  assert.ok(toA && toB);
  rejectResolution(store, toB.resolution_id, { reason: 'not the energy company' });
  assert.equal(store.getEntity(m.entityId).status, 'AMBIGUOUS', 'one candidate still open');
  confirmResolution(store, toA.resolution_id, { reason: 'checked by the user' });
  assert.equal(store.getEntity(m.entityId).merged_into_id, a.entityId);
  assert.equal(store.getResolution(toA.resolution_id).actor, 'USER');
  // a model suggestion is a candidate only and the system cannot confirm it
  const llm = resolveEntityMention(store, { label: 'Mistral AI SAS', type: 'ORGANIZATION', llmSuggestion: { entityId: a.entityId, reason: 'model thinks so' } });
  assert.equal(llm.outcome, 'CREATED');
  const llmProposal = llm.proposedResolutionIds.map(id => store.getResolution(id)).find(r => r.method === 'LLM_CANDIDATE');
  assert.equal(llmProposal.decision, 'PROPOSED');
  assert.throws(() => mergeEntities(store, llm.entityId, a.entityId, { actor: 'SYSTEM', method: 'LLM_CANDIDATE' }), e => e.code === 'KG_AUTO_MERGE_FORBIDDEN');
  assert.throws(() => mergeEntities(store, llm.entityId, a.entityId, { actor: 'SYSTEM', method: 'SIMILARITY_CANDIDATE' }), e => e.code === 'KG_AUTO_MERGE_FORBIDDEN');
  assert.equal(store.getEntity(llm.entityId).status, 'ACTIVE');
  assert.ok(store.verifyIntegrity().warnings.some(w => /ambiguous/.test(w)) || count(store, 'kg_entities', "status = 'AMBIGUOUS'") === 0);
  assertNoForcedMerge(store);
  store.close();
});

test('reimport: the same mentions from the same provenance create nothing new', async () => {
  const { store, sourceId, refId } = await storeWithSource();
  const mentions = [
    { label: 'Ada Lovelace', type: 'PERSON', identifiers: [{ scheme: 'wikidata', value: 'Q7259' }] },
    { label: 'Charles Babbage', type: 'PERSON' },
    { label: 'Analytical Engine', type: 'TECHNOLOGY', aliases: ['Machine analytique'] },
    { label: 'Jean Martin', type: 'PERSON' },
    { label: 'Jean Martin', type: 'PERSON' },
  ];
  const first = mentions.map(m => resolveEntityMention(store, { ...m, sourceRefId: refId }));
  const snapshot = () => Object.fromEntries(['kg_entities', 'kg_aliases', 'kg_entity_identifiers', 'kg_entity_resolutions', 'kg_sources', 'kg_source_refs'].map(t => [t, count(store, t)]));
  const before = snapshot();
  const second = mentions.map(m => resolveEntityMention(store, { ...m, sourceRefId: refId }));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(second.map(r => r.entityId), first.map(r => r.entityId));
  assert.ok(second.every(r => ['REIMPORTED', 'MATCHED_EXISTING'].includes(r.outcome)));
  // logical-source level (no ref): the same source corroborates its own earlier mention
  const viaSource = resolveEntityMention(store, { label: 'Charles Babbage', type: 'PERSON', sourceId });
  assert.equal(viaSource.entityId, first[1].entityId);
  assertNoForcedMerge(store);
  store.close();
});

test('reversible merge: claims, evidence, aliases and identifiers preserved; chain merges; guards', async () => {
  const { store, sourceId, refId } = await storeWithSource();
  const a = resolveEntityMention(store, { label: 'OpenAI', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'openai.com' }], sourceRefId: refId }).entityId;
  const b = resolveEntityMention(store, { label: 'Open AI LP', type: 'ORGANIZATION', identifiers: [{ scheme: 'registry_id', value: 'LP-42' }], sourceRefId: refId }).entityId;
  const c = resolveEntityMention(store, { label: 'OpenAI Global', type: 'ORGANIZATION', sourceRefId: refId }).entityId;
  const claimB = store.upsertClaim({ entity_id: b, claim_type: 'FACT', statement: 'Open AI LP was created in 2019', source_id: sourceId }).id;
  const evB = store.upsertEvidence({ source_id: sourceId, source_ref_id: refId, claim_id: claimB, evidence_type: 'DIRECT', content: 'created in 2019' }).id;
  const tables = ['kg_entities', 'kg_aliases', 'kg_entity_identifiers', 'kg_claims', 'kg_evidence', 'kg_claim_evidence'];
  const rows = () => Object.fromEntries(tables.map(t => [t, store.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(r => JSON.stringify({ ...r, status: undefined, merged_into_id: undefined, updated_at: undefined }))]));
  const before = rows();
  const m1 = mergeEntities(store, b, a, { actor: 'USER', reason: 'same company' });
  const m2 = mergeEntities(store, c, b, { actor: 'USER', reason: 'subsidiary name' });
  assert.equal(store.getResolution(m2.resolutionId).target_entity_id, a, 'a merge always points at the logical root');
  assert.deepEqual(rows(), before, 'no row deleted or rewritten (only status / redirect changed)');
  const view = store.getLogicalEntity(c);
  assert.equal(view.entity.entity_id, a);
  assert.deepEqual(view.claimIds, [claimB]);
  assert.ok(view.identifiers.some(i => i.scheme === 'registry_id'));
  assert.equal(store.getEvidenceForClaim(claimB)[0].evidence_id, evB);
  assert.throws(() => mergeEntities(store, b, c, { actor: 'USER' }), e => e.code === 'KG_ALREADY_MERGED');
  assert.throws(() => mergeEntities(store, a, c, { actor: 'USER' }), e => e.code === 'KG_MERGE_CYCLE');
  reverseResolution(store, m1.resolutionId, { reason: 'LP is a distinct legal entity' });
  assert.equal(store.getLogicalRootId(b), b);
  assert.equal(store.getLogicalRootId(c), a, 'c was merged directly into a and stays so');
  assert.deepEqual(store.getLogicalEntity(b).claimIds, [claimB], 'claims follow the restored entity');
  assert.deepEqual(rows(), before);
  assert.equal(store.verifyIntegrity().valid, true);
  assertNoForcedMerge(store);
  store.close();
});

test('reload / restart: entities, ledger, redirects and resolution state survive; a repeated mention is not duplicated', async () => {
  const file = path.join(TMP, 'restart.db');
  let store = await KnowledgeGraphStore.createTestStore(file);
  const s = store.upsertSource({ source_type: 'ARTICLE', name: 'R', logical_key: 'k:r' }).id;
  const ref = store.upsertSourceRef({ source_id: s, adapter: 'manual', source_ref: 'r1' }).id;
  const a = resolveEntityMention(store, { label: 'CERN', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'cern.ch' }], sourceRefId: ref }).entityId;
  const b = resolveEntityMention(store, { label: 'European Organization for Nuclear Research', type: 'ORGANIZATION', sourceRefId: ref }).entityId;
  const merge = mergeEntities(store, b, a, { actor: 'USER' });
  const amb = resolveEntityMention(store, { label: 'CERN', type: 'ORGANIZATION' });
  store.close();
  store = await KnowledgeGraphStore.createTestStore(file);
  assert.equal(store.getLogicalRootId(b), a);
  assert.equal(store.getResolution(merge.resolutionId).decision, 'CONFIRMED');
  assert.equal(store.getEntity(amb.entityId).status, 'AMBIGUOUS');
  const again = resolveEntityMention(store, { label: 'CERN', type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: 'cern.ch' }], sourceRefId: ref });
  assert.equal(again.entityId, a);
  assert.equal(store.verifyIntegrity().valid, true);
  store.close();
});

// ════════════════════════════════════════════════════════════════════════════
// Article Canonical: same MSN article via paste and URL
// ════════════════════════════════════════════════════════════════════════════

const HEADLINE = 'Le télescope Vera Rubin dévoile dix millions de galaxies';
const PARAGRAPHS = Array.from({ length: 12 }, (_, i) =>
  `Paragraphe ${i + 1} : l’observatoire installé au Chili a publié des images « inédites » du ciel austral, `
  + `avec des données vérifiables, des dates précises et des chiffres comme ${1200 + i} galaxies par degré carré. `
  + `Les astronomes de Tōkyō (東京) et de São Paulo saluent une avancée majeure 🚀 pour la cosmologie.`);
const ARTICLE_URL = 'https://www.msn.com/fr-fr/actualite/sciences/le-telescope-vera-rubin/ar-AA1vera';
const SHARED_URL = `${ARTICLE_URL}?ocid=msedgntp&cvid=4f2a&ei=12#comments`;
const msnHtml = `<!doctype html><html><head>
  <title>${HEADLINE} - MSN</title>
  <meta property="og:site_name" content="MSN">
  <meta property="og:title" content="${HEADLINE}">
  <link rel="canonical" href="https://www.publisher.example/sciences/vera-rubin">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: HEADLINE,
    author: { '@type': 'Person', name: 'Jean Dupont' }, datePublished: '2026-10-03T08:15:00Z',
    articleBody: PARAGRAPHS.join('\n\n'),
  })}</script>
</head><body><nav>Accueil Actualité Sciences</nav><div id="root"></div></body></html>`;
const pastedMsn = [HEADLINE.normalize('NFD'), 'Histoire de Jean Dupont', 'Publié le 03/10/2026 à 10:15',
  ...PARAGRAPHS.map((p, i) => (i === 2 ? `​${p.replace(/ /, ' ')}` : p))].join('\r\n');

function urlPathExtraction(html, url) {
  const inspected = extractArticleCandidatesFromHtml(html, url);
  assert.ok(inspected.best?.quality.complete);
  return {
    fallback: false, text: inspected.best.text, fullText: inspected.best.text, title: inspected.best.title,
    source_type: 'web', word_count: inspected.best.quality.words, truncated: false,
    imageUrls: inspected.best.imageUrls, page: inspected.page,
    extraction: { chosenExtractor: inspected.best.source, qualityStatus: 'COMPLETE' },
  };
}

/** The neuron Docteur saves for a capture (Article Canonical structure). */
function capturedNeuron(id, article, captureId) {
  const { child } = buildArticleNeurons(article, { analysis: 'Résumé.', title: article.title, modelUsed: 'scripted', captureId });
  return { id, title: child.title, kind: child.kind, metadata: child.metadata, createdAt: '2026-10-07T10:00:00.000Z' };
}

test('same article via MSN paste + URL extraction: 1 logical source, 2 technical refs, divergences reported not hidden', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const viaUrl = buildCanonicalArticle(articleInputFromExtraction(SHARED_URL, urlPathExtraction(msnHtml, SHARED_URL), { captureId: 'c-url' }));
  const viaPaste = buildCanonicalArticle({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL });
  assert.equal(viaPaste.contentHash, viaUrl.contentHash, 'Article Canonical converged (precondition)');
  const urlNeuron = capturedNeuron('neuron-url', viaUrl, 'c-url');
  const msnNeuron = capturedNeuron('neuron-msn', viaPaste, 'c-msn');

  const r1 = ingestArticleNeuron(store, msnNeuron);
  const r2 = ingestArticleNeuron(store, urlNeuron);
  assert.equal(r1.logicalSourceCreated, true);
  assert.equal(r2.logicalSourceCreated, false);
  assert.equal(r2.matchedBy, 'canonical_url');
  assert.equal(r2.sourceId, r1.sourceId);
  assert.equal(count(store, 'kg_sources'), 1, 'logical source count = 1');
  const refs = store.getSourceRefs(r1.sourceId);
  assert.equal(refs.length, 2, 'technical provenance refs = 2');
  assert.deepEqual(refs.map(r => r.input_path).sort(), ['paste', 'url']);
  assert.deepEqual(refs.map(r => r.source_ref).sort(), ['neuron-msn', 'neuron-url']);
  assert.ok(refs.every(r => r.content_hash === viaUrl.contentHash));
  assert.equal(refs.find(r => r.input_path === 'url').provenance.extractor, 'json-ld');
  assert.equal(refs.find(r => r.input_path === 'url').original_url, SHARED_URL, 'original URL kept on the technical path');
  const source = store.getSource(r1.sourceId);
  assert.equal(source.canonical_url, ARTICLE_URL);
  assert.equal(source.content_hash, viaUrl.contentHash);
  assert.equal(source.name, HEADLINE);

  // re-import: idempotent
  ingestArticleNeuron(store, msnNeuron);
  ingestArticleNeuron(store, urlNeuron);
  assert.equal(count(store, 'kg_sources'), 1);
  assert.equal(count(store, 'kg_source_refs'), 2);

  // a paste without URL converges through the content hash (third path, same logical source)
  const pasteNoUrl = capturedNeuron('neuron-paste-nourl', buildCanonicalArticle({ path: 'paste', text: pastedMsn, source: 'msn' }), 'c-3');
  const r3 = ingestArticleNeuron(store, pasteNoUrl);
  assert.equal(r3.sourceId, r1.sourceId);
  assert.equal(r3.matchedBy, 'content_hash');

  // same URL, different body (article updated): same logical source as Article Canonical decides, divergence exposed
  const updated = buildCanonicalArticle({ path: 'paste', text: `${pastedMsn}\r\nMise à jour : correction du chiffre.`, source: 'msn', url: SHARED_URL });
  const r4 = ingestArticleNeuron(store, capturedNeuron('neuron-updated', updated, 'c-4'));
  assert.equal(r4.sourceId, r1.sourceId);
  assert.deepEqual(r4.divergences, ['content_hash_differs']);
  assert.deepEqual(store.findSourceRef('article_capture', 'neuron-updated').provenance.divergences, ['content_hash_differs']);

  // a different article is a different logical source
  const other = buildCanonicalArticle({ path: 'paste', text: 'Un tout autre article sur la météo de demain, avec assez de mots pour exister.', source: 'msn', url: 'https://www.msn.com/fr-fr/meteo/ar-AA2' });
  assert.notEqual(ingestArticleNeuron(store, capturedNeuron('neuron-other', other, 'c-5')).sourceId, r1.sourceId);

  // entity resolution on top does not hide the provenance: the publisher mention from both paths is one entity
  const urlRef = store.findSourceRef('article_capture', 'neuron-url').source_ref_id;
  const msnRef = store.findSourceRef('article_capture', 'neuron-msn').source_ref_id;
  const p1 = resolveEntityMention(store, { label: 'Jean Dupont', type: 'PERSON', sourceRefId: msnRef });
  const p2 = resolveEntityMention(store, { label: 'Jean Dupont', type: 'PERSON', sourceRefId: urlRef });
  assert.equal(p2.entityId, p1.entityId, 'same logical source corroborates');
  assert.deepEqual(store.getAliasesForEntity(p1.entityId).map(a => a.source_ref_id).sort(), [msnRef, urlRef].sort());
  assert.equal(store.getSourceRefs(r1.sourceId).length, 4, 'every technical path still listed');
  assertNoForcedMerge(store);
  store.close();
});

test('article privacy: a private capture makes the logical source local-only', async () => {
  const store = await KnowledgeGraphStore.createTempStore();
  const article = buildCanonicalArticle({ path: 'paste', text: pastedMsn, source: 'msn', url: SHARED_URL });
  const pub = capturedNeuron('n-public', article, 'c1');
  const priv = capturedNeuron('n-private', article, 'c2');
  priv.metadata = { ...priv.metadata, private: true };
  const r = ingestArticleNeuron(store, pub);
  assert.equal(store.getSource(r.sourceId).egress_policy, 'cloud_allowed');
  ingestArticleNeuron(store, priv);
  assert.equal(store.getSource(r.sourceId).privacy, 'PRIVATE');
  assert.equal(store.getSource(r.sourceId).egress_policy, 'local_only');
  store.close();
});

// ════════════════════════════════════════════════════════════════════════════
// Notebook source preservation (frozen public contracts, temporary database)
// ════════════════════════════════════════════════════════════════════════════

function notebookSnapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'nb\\_%' ESCAPE '\\' OR name LIKE 'notebook%') AND name NOT LIKE '%fts%' ORDER BY name").all().map(r => r.name);
  const hash = crypto.createHash('sha256');
  for (const t of tables) hash.update(t).update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  return { tables, sha256: hash.digest('hex') };
}

test('Notebook sources: read through public contracts, Notebook rows byte-identical, refs resolve back', async () => {
  const dbFile = path.join(TMP, 'notebook-and-kg.db');
  initSqlite(dbFile);
  ensureNotebookDocsSchema(getDatabase());
  createNotebook({ id: 'nb-public', title: 'Public notebook' });
  createNotebook({ id: 'nb-private', title: 'Private notebook' });
  setNotebookPrivacy('nb-private', { privacy: true, egressPolicy: 'local_only' });
  const doc = (documentId, notebookId, title, hash, canonicalUri = null) => {
    insertDocument({ documentId, notebookId, nameKey: title.toLowerCase(), title, mimeType: 'application/pdf', hash, size: 10, canonicalUri, status: 'READY' });
    updateDocument(documentId, { currentVersionId: `nver-${documentId}` });
  };
  doc('ndoc-1', 'nb-public', 'Rapport.pdf', 'hash-rapport');
  doc('ndoc-2', 'nb-private', 'Rapport (copie).pdf', 'hash-rapport');
  doc('ndoc-3', 'nb-public', 'Page web', 'hash-web', 'https://Example.com/page/?utm_source=x');
  const before = notebookSnapshot(getDatabase());
  assert.ok(before.tables.includes('nb_documents'));

  // the KG lives in the same temporary database file, in its own kg_* tables
  const store = await KnowledgeGraphStore.createTestStore(dbFile);
  const results = [];
  for (const notebookId of ['nb-public', 'nb-private']) {
    for (const d of listDocuments(notebookId)) results.push(ingestNotebookDocument(store, { document: getDocument(d.documentId), notebook: getNotebook(notebookId) }));
  }
  for (const notebookId of ['nb-public', 'nb-private']) {
    for (const d of listDocuments(notebookId)) ingestNotebookDocument(store, { document: getDocument(d.documentId), notebook: getNotebook(notebookId) });
  }
  assert.deepEqual(notebookSnapshot(getDatabase()), before, 'Notebook rows untouched');
  assert.equal(count(store, 'kg_sources'), 2, 'same file in two notebooks = one logical document');
  assert.equal(count(store, 'kg_source_refs'), 3, 'each Notebook document stays its own technical ref');
  const shared = store.findSourceRef('notebook_document', 'ndoc-1').source_id;
  assert.equal(store.findSourceRef('notebook_document', 'ndoc-2').source_id, shared);
  assert.equal(store.getSource(shared).privacy, 'PRIVATE', 'the private notebook copy makes the logical source private');
  for (const ref of store.db.prepare("SELECT * FROM kg_source_refs WHERE adapter = 'notebook_document'").all()) {
    const resolved = getDocument(ref.source_ref);
    assert.ok(resolved, `${ref.source_ref} resolves through the Notebook contract`);
    assert.equal(ref.version_ref, resolved.currentVersionId);
  }
  assert.equal(store.findSourceRef('notebook_document', 'ndoc-3').original_url, 'https://Example.com/page/?utm_source=x');
  assert.equal(store.getSource(store.findSourceRef('notebook_document', 'ndoc-3').source_id).canonical_url, 'https://example.com/page');
  assert.equal(results.filter(r => r.logicalSourceCreated).length, 2);
  store.close();
  assert.deepEqual(notebookSnapshot(getDatabase()), before);
});

// ════════════════════════════════════════════════════════════════════════════
// Volume (synthetic): correctness at 1 000 entities, cost reported
// ════════════════════════════════════════════════════════════════════════════

test('volume: 1 000 synthetic entities + 1 000 mentions — no forced merge, deterministic outcome', async () => {
  const { store, refId } = await storeWithSource();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    resolveEntityMention(store, { label: `Organisation ${i}`, type: 'ORGANIZATION', identifiers: [{ scheme: 'domain', value: `org${i}.example` }], sourceRefId: refId });
  }
  const createMs = performance.now() - t0;
  const t1 = performance.now();
  let matched = 0;
  let ambiguous = 0;
  for (let i = 0; i < 1000; i++) {
    const withId = i % 2 === 0;
    const r = resolveEntityMention(store, { label: `organisation ${i}`, type: 'ORGANIZATION', ...(withId ? { identifiers: [{ scheme: 'domain', value: `www.org${i}.example` }] } : {}) });
    if (r.outcome === 'MATCHED_EXISTING') matched++;
    if (r.outcome === 'AMBIGUOUS') ambiguous++;
  }
  const resolveMs = performance.now() - t1;
  assert.equal(matched, 500, 'every mention with a stable identifier matched');
  assert.equal(ambiguous, 500, 'every bare same-label mention stays ambiguous');
  assertNoForcedMerge(store);
  console.log(`# KG-3 volume 1000: create ${createMs.toFixed(0)} ms (${(createMs / 1000).toFixed(2)} ms/mention), resolve ${resolveMs.toFixed(0)} ms (${(resolveMs / 1000).toFixed(2)} ms/mention)`);
  store.close();
});
